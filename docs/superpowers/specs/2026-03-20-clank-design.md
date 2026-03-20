# Clank — Test Suite Lifecycle Management Plugin

**Date:** 2026-03-20
**Status:** Approved
**Author:** Nick

---

## Overview

Clank is a standalone Claude Code plugin for managing the full lifecycle of a test suite: auditing quality, bootstrapping coverage, refactoring structure, and watching for drift. It is modeled on the GSD plugin architecture and designed to be language-agnostic, subagent-driven, and CodeGraph-aware.

The guiding principle: test suites are first-class artifacts. Clank treats them with the same rigor applied to production code — using state-of-the-art techniques drawn from foundational software testing literature, with behavior preservation as an inviolable constraint.

---

## Goals

- Maintain a solid, clean test suite as production code evolves
- Bootstrap test coverage on untested or undertested codebases
- Refactor large or messy suites without losing coverage
- Detect drift between production code and tests across sessions
- Produce a persistent, queryable history of findings and actions
- Minimize token usage via CodeGraph navigation and scoped subagents

---

## Non-Goals

- Clank does not fix bugs in production code
- Clank does not change what code does — only what tests verify
- Clank does not support interactive test editing (all changes are agent-driven with human approval gates)
- No CI/CD integration in v1

---

## Architecture

Clank follows the GSD plugin structure exactly:

```
clank/
├── .claude-plugin/
│   └── plugin.json
├── commands/clank/
│   ├── audit.md
│   ├── bootstrap.md
│   ├── refactor.md
│   └── watch.md
├── agents/
│   ├── clank-auditor.md
│   ├── clank-bootstrapper.md
│   ├── clank-refactorer.md
│   └── clank-watcher.md
├── clank/
│   ├── workflows/
│   │   ├── audit.md
│   │   ├── bootstrap.md
│   │   ├── refactor.md
│   │   └── watch.md
│   ├── references/
│   │   ├── stack-detection.md
│   │   ├── report-schema.md
│   │   ├── behavior-preservation.md
│   │   ├── testing-philosophy.md
│   │   ├── scope-resolution.md
│   │   └── anti-patterns.md
│   └── templates/
│       ├── audit-report.md
│       ├── bootstrap-report.md
│       ├── refactor-report.md
│       └── watch-report.md
├── bin/
│   └── clank-tools.cjs
├── hooks/
│   └── session-start
└── README.md
```

**Layer responsibilities:**

- **commands/clank/*.md** — Entry points invoked by the user. Lightweight: load context, invoke workflow.
- **clank/workflows/*.md** — Full mode logic. Orchestrates scope resolution, subagent spawning, report assembly, approval gates.
- **agents/*.md** — Specialized subagents with YAML frontmatter. Each has a single responsibility. Subagents write their results to scratch files; they do not return data through the agent API.
- **clank/references/*.md** — Shared knowledge consumed by all agents. Never duplicated across workflows.
- **clank/templates/*.md** — Markdown templates agents use as scaffolding when writing final report files. Agents fill in sections; `clank-tools.cjs` does not render reports.
- **bin/clank-tools.cjs** — Node.js tool for: report ID generation, report index queries, stack detection, CodeGraph presence and staleness checks, `.clank/config.json` state management, scratch directory management, report validation.
- **hooks/session-start** — Loads recent report summaries into context; surfaces CodeGraph suggestion if absent.

---

## The Four Modes

### `/clank:audit`

Read-only analysis of a test suite. The agent asks what scope to analyze (full project, directory, file, or function), then:

1. Detects stack and checks CodeGraph presence/freshness
2. Spawns parallel `clank-auditor` subagents per module or directory within scope
3. Each subagent writes findings to `.clank/scratch/{run-id}/{agent-index}.json`
4. Orchestrator merges scratch files into `clank_reports/audit-{ID}.md`
5. Never touches production code or test files

### `/clank:bootstrap`

Generates tests for untested or undertested code. The agent asks what to cover and how (full public API, happy paths only, edge cases), then:

1. Reads production code; infers behavior from implementation
2. Writes `clank_reports/bootstrap-{ID}.md` detailing planned tests — with status `awaiting_approval`
3. Waits for user approval before writing any test files
4. On approval: spawns `clank-bootstrapper` subagents per file; each writes new test files and updates the report to `in_progress`
5. On completion: report status set to `complete`
6. Bootstrap is additive only — existing test files are never written to; subagents may read existing test helpers to avoid duplicating fixtures but must not modify them
7. Tests describe *what the code does* (characterization), not what it should do — see Bootstrap Characterization Contract below

### `/clank:refactor`

Structural improvements to an existing suite. The agent asks what to refactor and why, then:

1. Runs the full suite; captures baseline. Aborts if baseline is broken — "broken" means non-zero exit code or compilation failure. Skipped/xfail tests do not block the baseline.
2. Writes `clank_reports/refactor-{ID}.md` with planned changes — status `awaiting_approval`
3. Creates `.clank/journals/refactor-{ID}.json` with all planned units as `{ file, status: pending }`
4. Waits for user approval
5. On approval: executes units **sequentially** (no parallel writes — concurrent writes to shared fixtures cause conflicts)
6. After each unit: runs the **full suite** (not just "affected tests" — scope determination is unreliable); reverts and marks unit `reverted` in journal if regression; continues to next unit
7. On completion: report status set to `complete` or `partial` if any units were reverted
8. Scope: deduplication, naming, fixture extraction, domain reorganization, parameterization of near-identical test variants
9. Never changes what is being tested — only how it is organized

### `/clank:watch`

Drift detection between production code and the test suite. Runs on-demand or via session-start hook:

1. Loads the most recent audit report whose scope covers the current watch scope. If none exists, or the baseline scope is narrower than the current watch scope, runs a lightweight inline audit first (full project, single `clank-watcher` agent, no parallelism) to establish a baseline.
2. Detects drift using semantic diff: new production files with no test file, functions whose signatures or control flow changed since the baseline (not cosmetic/whitespace changes), test files referencing deleted or renamed symbols
3. Writes `clank_reports/watch-{ID}.md` with a prioritized action list — references `based_on: {prior-audit-id}`
4. Does not make changes — surfaces what needs attention

**What counts as "changed" for drift detection:** signature changes, added/removed parameters, new branches in control flow, changed return types. Whitespace, comments, and doc-string-only changes do not trigger drift alerts.

---

## Scope Resolution

All modes start with an agent-driven conversation to determine scope. No command-line arguments. The agent asks in plain language:

- "What would you like to audit? (full project, a directory, specific files, or a single function?)"
- "Do you want to cover the full public API or focus on a specific area?"

The agent resolves answers to a formal scope object written to the report frontmatter:

```json
{
  "type": "file | directory | function | project",
  "paths": ["src/utils/parser.ts"],
  "symbols": ["parseDate"]
}
```

`symbols` is only populated for function-level scope. All orchestrators and subagents consume this structure — never freeform strings.

Stack detection resolves per-path for monorepos: walk up from each path in `scope.paths` to the nearest manifest file, not the project root. If multiple paths resolve to different stacks, Clank treats each stack independently and labels them separately in the report.

A `clank/references/scope-resolution.md` document guides all agents on how to ask, what to ask, and how to resolve answers to the scope object.

---

## Subagent Communication Protocol

Subagents do not return data through the agent API. All inter-agent communication happens through scratch files:

**Scratch directory:** `.clank/scratch/{run-id}/` — created by the orchestrator before spawning agents; deleted on successful report completion.

**Subagent output format:** Each subagent writes a single JSON file to its assigned scratch path:

```json
{
  "agent_index": 0,
  "scope": { "type": "directory", "paths": ["src/utils/"] },
  "status": "complete | error",
  "findings": [],
  "error": null
}
```

**Merge:** Orchestrator reads all scratch files after all subagents complete, validates each for `status: complete`, merges `findings` arrays, and assembles the final report. Scratch files with `status: error` are noted in the report with their `error` field; the run is marked `partial` rather than `failed`.

**Parallelism by mode:**

| Mode | Parallelism | Reason |
|------|-------------|--------|
| audit | Parallel per module/directory | Read-only; safe to parallelize |
| bootstrap | Parallel per file | Writes to new files only; no conflicts |
| refactor | Sequential | Shared fixture writes conflict when parallel |
| watch | Single agent | Lightweight; no parallelism needed |

---

## CodeGraph Integration

When `.codegraph/` exists in the project, Clank agents use it as the primary navigation layer:

| Task | CodeGraph tool |
|------|---------------|
| Find untested functions | `codegraph_search` filtered by symbol type |
| Trace what a function calls | `codegraph_callees` |
| Find what calls into a module | `codegraph_callers` |
| Assess refactor blast radius | `codegraph_impact` |
| Get source for a specific symbol | `codegraph_node` |

**Freshness check:** Before using CodeGraph, `clank-tools codegraph-fresh` compares the graph's last-built timestamp against `git log --since`. If significant commits have landed since the last index, the agent warns in the report: `codegraph_confidence: stale` and falls back to Grep/Glob for that session.

**If `.codegraph/` is absent:** The session-start hook surfaces a one-time suggestion:

> "This project doesn't have CodeGraph initialized. Running `codegraph init -i` would let Clank navigate your codebase more accurately and use significantly fewer tokens. Want me to run it now?"

Shown once per project; tracked in `.clank/config.json` as `codegraph_suggestion_shown: true`.

**Grep/Glob fallback:** Results are tagged `confidence: low` in scratch files and the final report's Raw Data section. Symbol matches via text search are not treated as equivalent to CodeGraph results — the report distinguishes them explicitly.

---

## Report Schema

All reports live in `clank_reports/` in the user's project. `clank_reports/` is always resolved relative to the project root (the directory containing `.clank/`). Report IDs are `{mode}-{YYYYMMDD}-{HHmmss}-{NNN}` where `NNN` is a zero-padded counter reset per second to avoid collisions from rapid re-invocation.

```markdown
---
id: audit-20260320-143022-001
mode: audit
scope:
  type: directory
  paths: ["src/utils/"]
  symbols: []
stack: typescript/vitest
codegraph_confidence: high | low | stale
created_at: 2026-03-20T14:30:22Z
status: complete | partial | awaiting_approval | in_progress | corrupt
based_on: null
---

# Clank {Mode} Report

## Scope
...

## Findings
(mode-specific sections)

## Metrics
- Files analyzed: 12
- Functions covered: 34/41 (82%)
- Issues found: 3 blocking, 2 advisory

## Recommended Actions
1. ...

## Raw Data
<!-- structured JSON for agent consumption; tags confidence level of each assertion -->
```

**Report status lifecycle:**

```
planned → awaiting_approval → in_progress → complete
                                         → partial   (some units reverted)
                           → corrupt     (write interrupted; parse error on load)
```

**Corrupt report handling:** `clank-tools validate {path}` checks frontmatter and body structure. Corrupt reports are indexed with `status: corrupt` and skipped in `recent` and `based_on` chain lookups rather than crashing. A corrupt report is reported to the user on next session start.

**`bin/clank-tools.cjs`** exposes:

```
clank-tools report-id {mode}            → string: "audit-20260320-143022-001"
clank-tools recent {n}                  → JSON array of {id, mode, status, scope, created_at, summary}
clank-tools detect-stack {path}         → JSON: {language, framework, test_runner, manifest_path}
clank-tools codegraph-present           → boolean
clank-tools codegraph-fresh             → JSON: {fresh: boolean, last_built, commits_since}
clank-tools validate {report-path}      → JSON: {valid: boolean, error?}
clank-tools scratch-init {run-id}       → creates .clank/scratch/{run-id}/; returns path
clank-tools scratch-merge {run-id}      → reads all scratch files; returns merged findings JSON
clank-tools scratch-clean {run-id}      → deletes .clank/scratch/{run-id}/
clank-tools config-get {key}            → value from .clank/config.json
clank-tools config-set {key} {value}    → writes to .clank/config.json (single-session; no concurrency lock in v1)
```

**Note on concurrent sessions:** `.clank/config.json` writes are not locked in v1. Running two Clank modes simultaneously in the same project can produce last-write-wins behavior on config fields. This is a known limitation; concurrent Clank sessions in the same project are not a supported use case in v1.

---

## Approval Gate

Bootstrap and refactor require explicit user approval before writing files. The approval gate state is tracked in the report's `status` field and in `.clank/journals/` for refactor.

**Bootstrap approval flow:**

1. Report written with `status: awaiting_approval` — contains the full test plan
2. Agent presents a summary and asks: "Approve this plan to generate the test files?"
3. On approval: report updated to `in_progress`; subagents spawned
4. On completion: report updated to `complete`
5. If the session ends before approval: the report persists with `awaiting_approval`; a future session can resume by reading the report and re-presenting the plan

**Refactor approval flow:**

Same as bootstrap, plus the journal file:

1. Report written with `status: awaiting_approval`; journal created with all units as `pending`
2. On approval: report updated to `in_progress`
3. Each unit executed; journal updated (`done` or `reverted`) after each
4. On completion: report updated to `complete` (all done) or `partial` (any reverted)
5. If the session ends mid-refactor: the journal persists; a future session reads the journal and resumes from the first `pending` unit

---

## Behavior-Preservation Contract

Defined in `clank/references/behavior-preservation.md`. Read by every agent that writes code or tests. Non-negotiable.

1. **Baseline first.** Run the full test suite before any changes. "Broken baseline" = non-zero exit code or compilation failure. Skipped and xfail tests do not block the baseline. If broken, stop and report. Never start from a broken baseline.
2. **Atomic changes.** Each file or function changed is a separate, independently-verifiable unit tracked in the journal.
3. **Full suite after each unit.** Run the complete test suite — not a scoped subset — after each change. Scope determination is unreliable; full suite is the only safe verification. If a regression is found, revert the unit immediately, mark it `reverted` in the journal, document in the report, and continue to the next unit.
4. **Report failures, never suppress.** If a change can't be made safely, the report says why. The user decides next steps.
5. **Bootstrap is additive only.** New test files only. No existing test file is written by bootstrap. Subagents may read existing test helpers to avoid fixture duplication.
6. **Refactor is structural only.** No changes to what is being tested — only how it is organized. No behavior modifications, no new assertions, no deleted assertions.

---

## Bootstrap Characterization Contract

Characterization tests capture *current behavior*, not correct behavior. They are safety nets for legacy code, not specifications.

**Naming convention:** All bootstrap-generated tests must follow the naming pattern `characterizes_{behavior_description}` (Python) or `characterizes {behavior description}` (Jest/Vitest) to signal their provisional nature.

**Defect annotation:** If the agent identifies code that appears to contain a bug (off-by-one, null not handled, obvious logic error), it must:
1. Still generate a test that captures the current (buggy) behavior
2. Add a comment directly above the test: `# CHARACTERIZATION: this test captures current behavior which may be incorrect — see [description of suspected defect]`
3. Note the suspected defect in the report under a "Suspected Defects" section

**Inference limit:** If the behavior of a function cannot be inferred from implementation alone (e.g., the function delegates entirely to an external service, depends on global mutable state, or requires running the code to observe), the agent must:
1. Leave that function unbootstrapped
2. Note it in the report under "Functions Requiring Manual Characterization" with the reason

Generating low-quality tests for uninferrable behavior is worse than generating no tests.

---

## Testing Philosophy

Defined in `clank/references/testing-philosophy.md`. Read by every agent that writes or evaluates tests. Violations at **blocking** severity prevent a report from being marked `status: complete`. Violations at **advisory** severity are reported but do not block completion.

### Test Layers Model

Before evaluating any test, agents classify it by layer using the test pyramid:

- **Unit test** — tests one function/class in isolation; dependencies mocked or stubbed
- **Integration test** — crosses process/service/DB boundaries; minimal mocking
- **End-to-end test** — tests a full user workflow; no mocking

Mocking advice is layer-specific: excessive mocking is an anti-pattern in unit tests and integration tests alike, but for different reasons. The "mock only at architectural boundaries" rule applies to unit tests. Integration tests should mock nothing within the system boundary. Evaluating mocking without first classifying the test layer is an error.

### Philosophy Rules

| Rule | Severity | Source |
|------|----------|--------|
| One concept per test | Blocking | Osherove — *The Art of Unit Testing* |
| Test behavior not implementation | Blocking | Freeman & Pryce — *GOOS* |
| Tests must be readable as documentation | Blocking | Beck — *TDD By Example* |
| No logic in tests (loops, conditionals) | Blocking | Osherove |
| Arrange-Act-Assert structure, always | Blocking | Meszaros — *xUnit Test Patterns* |
| Mock only at architectural boundaries (unit tests) | Blocking | Freeman & Pryce |
| A test that can't fail is worse than no test | Blocking | Beck |
| Characterization tests before refactoring legacy | Blocking | Feathers — *Working Effectively with Legacy Code* |
| Test names describe behavior in plain language | Blocking | Osherove |
| Tests are first-class code — same quality standards | Blocking | Martin — *Clean Code* |
| Test helpers expose one entry point, not a multi-object assembly | Advisory | Ousterhout — *A Philosophy of Software Design* (adapted) |
| No assertion roulette — multiple bare asserts without failure context | Blocking | Meszaros |

**Detecting "a test that can't fail":** The audit agent checks for: assertions inside bare `catch`/`except` blocks that swallow exceptions, assertions on values that are guaranteed by construction (e.g., `expect(x).toBe(x)`), test bodies with no assertion at all, and tests that assert on a mock's own return value.

---

## Stack Detection

Defined in `clank/references/stack-detection.md`.

**Monorepo resolution:** Detection walks up from each path in `scope.paths` to the nearest manifest — not the project root. This ensures each scoped path gets the correct stack for its package.

**Multiple manifest conflict:** If a single path has both `package.json` and `pyproject.toml` at the same level (polyglot or build-tool co-location), the agent asks the user which stack to use for that scope. Never silently infer the wrong runner.

**Detection order (per path):**

1. `package.json` → Node/TypeScript; inspect `devDependencies` for test runner (vitest, jest, mocha, jasmine)
2. `pyproject.toml` / `requirements.txt` → Python; look for pytest, unittest
3. `Cargo.toml` → Rust; `cargo test` is standard
4. `go.mod` → Go; `go test ./...` is standard
5. `mix.exs` → Elixir; ExUnit
6. Conflict or unrecognized: ask the user

Stack is written per-scope-path in the report frontmatter. If all paths resolve to the same stack, it is written as a single value.

---

## Anti-Patterns Reference

`clank/references/anti-patterns.md` catalogs test smells the audit agent detects:

- Testing implementation details (asserting on private state, mocking internals)
- Logic in tests (conditionals, loops)
- Multiple concepts per test
- Tests that always pass (no assertion, wrong exception type caught)
- Tautological assertions (asserting a value against itself: `expect(x).toBe(x)`, `assert result == result`)
- Assertion roulette (multiple bare assertions with no per-assertion failure message, making failures undiagnosable)
- Unclear test names ("test1", "works correctly", "handles error")
- Excessive mocking hiding real behavior (evaluate per test layer — see Testing Philosophy)
- Flaky tests: `time.sleep`/`asyncio.sleep` in test bodies, unordered collection iteration in assertions, unseeded `Date.now()`/`Math.random()`, network calls without mocking, race conditions in async tests
- Fixture data that changes between runs (time, random values) without seeding
- Tests that depend on execution order
- Dead tests (commented out, never run, always skipped with no explanation)
- Giant setup blocks that obscure what is being tested
- Characterization tests without the `characterizes_` naming convention (indicates they were written without the contract)

---

## Large Suite Performance

For suites where a full run takes more than a few minutes, refactor mode can be slow (full suite run per unit). Users can configure a scoped runner command in `.clank/config.json`:

```json
{
  "test_run_command": "vitest run --project api"
}
```

If `test_run_command` is set, refactor uses it in place of the default runner. The refactor report notes which runner was used. This is a user-configured override — Clank does not auto-infer a faster runner.

If no scoped runner is configured and the suite takes more than 2 minutes per run, the refactor report includes a warning with the estimated total wall time.

---

## Installation

```bash
claude install clank
# or
npx clank install
```

The installer:
1. Copies `commands/clank/` → `.claude/commands/clank/`
2. Copies `agents/` → `.claude/agents/`
3. Copies `clank/` → `~/.claude/clank/`
4. Copies `bin/` → `~/.claude/clank/bin/`
5. Registers session-start hook in `.claude/settings.json`
6. Creates `.clank/` state directory in project if absent

**Global install model:** All projects on the same machine share one Clank installation at `~/.claude/clank/`. Updating Clank (`claude update clank`) affects all projects. Per-project version pinning is deferred to a future version.

---

## `.clank/` Project State

```
.clank/
├── config.json          # per-project config
├── journals/
│   └── refactor-{ID}.json   # per-run refactor journal
└── scratch/
    └── {run-id}/        # ephemeral; cleaned up on report completion
        ├── 0.json
        ├── 1.json
        └── ...
```

**`config.json` schema:**

```json
{
  "codegraph_suggestion_shown": false,
  "last_audit": "audit-20260320-143022-001",
  "last_bootstrap": null,
  "last_refactor": null,
  "last_watch": null,
  "test_run_command": null
}
```

**Journal schema (refactor):**

```json
{
  "run_id": "refactor-20260320-143022-001",
  "units": [
    { "file": "tests/utils/parser.test.ts", "description": "extract date fixtures", "status": "done" },
    { "file": "tests/utils/format.test.ts", "description": "rename to describe behavior", "status": "pending" }
  ]
}
```

---

## Open Questions (deferred to implementation)

- Should `watch` mode run automatically on `git commit` via a hook, or only on-demand?
- Report retention policy — does Clank ever prune old reports, or is that left to the user?
- Should the refactor journal support a `/clank:refactor --resume {ID}` command, or does the next session auto-detect and offer to resume?
