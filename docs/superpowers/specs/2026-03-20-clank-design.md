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
- **clank/workflows/*.md** — Full mode logic. Orchestrates scope resolution, subagent spawning, report writing, approval gates.
- **agents/*.md** — Specialized subagents with YAML frontmatter. Each has a single responsibility.
- **clank/references/*.md** — Shared knowledge consumed by all agents. Never duplicated across workflows.
- **clank/templates/*.md** — Report structure templates used by `clank-tools.cjs` when generating reports.
- **bin/clank-tools.cjs** — Node.js tool for report ID generation, index queries, stack detection, CodeGraph presence check, `.clank/config.json` state management.
- **hooks/session-start** — Loads recent report summaries into context; surfaces CodeGraph suggestion if absent.

---

## The Four Modes

### `/clank:audit`

Read-only analysis of a test suite. The agent asks what scope to analyze (full project, directory, file, or function), then:

1. Checks for CodeGraph; uses it for navigation if present
2. Analyzes the suite for: coverage gaps, anti-patterns, redundancy, suite health metrics
3. Writes `clank_reports/audit-{ID}.md` with full findings
4. Never touches production code or test files

### `/clank:bootstrap`

Generates tests for untested or undertested code. The agent asks what to cover and how (full public API, happy paths only, edge cases), then:

1. Reads production code; infers behavior from implementation
2. Writes `clank_reports/bootstrap-{ID}.md` detailing planned tests
3. Waits for user approval before writing any test files
4. Generates tests that describe *what the code does*, not what it should do
5. Bootstrap is additive only — never modifies existing test files

### `/clank:refactor`

Structural improvements to an existing suite. The agent asks what to refactor and why, then:

1. Runs the full suite; captures baseline results. Aborts if baseline is broken.
2. Writes `clank_reports/refactor-{ID}.md` with planned changes
3. Waits for user approval
4. Makes changes atomically (one unit at a time)
5. Re-runs tests after each unit; reverts and reports if anything regresses
6. Scope: deduplication, naming, fixture extraction, domain reorganization
7. Never changes what is being tested — only how it is organized

### `/clank:watch`

Drift detection between production code and the test suite. Runs on-demand or via session-start hook:

1. Loads the most recent audit report as baseline
2. Detects: new production files with no tests, changed functions whose tests haven't been updated, deleted tests with no explanation
3. Writes `clank_reports/watch-{ID}.md` with a prioritized action list
4. Does not make changes — surfaces what needs attention

---

## Scope Resolution

All modes start with an agent-driven conversation to determine scope. No command-line arguments. The agent asks in plain language:

- "What would you like to audit? (full project, a directory, specific files, or a single function?)"
- "Do you want to cover the full public API or focus on a specific area?"

The agent maps answers to file paths using CodeGraph or Glob/Grep fallback. Scope is recorded in the report frontmatter.

A `clank/references/scope-resolution.md` document guides all agents on how to ask, what to ask, and how to resolve answers to paths.

---

## Subagent Strategy

Each mode has an orchestrator workflow that stays lean and delegates:

| Mode | Orchestrator | Subagent | Parallelism |
|------|-------------|----------|-------------|
| audit | audit.md workflow | clank-auditor | Per module/directory |
| bootstrap | bootstrap.md workflow | clank-bootstrapper | Per file |
| refactor | refactor.md workflow | clank-refactorer | Per logical unit |
| watch | watch.md workflow | clank-watcher | Single agent |

Orchestrators: discover scope → assign work → merge results → write report. They never write code or tests.

Subagents: receive a specific, bounded task. They read the relevant reference docs, do the work, and return a structured result to the orchestrator.

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

This avoids reading every source file — agents navigate the graph and pull source only for symbols they need to inspect.

**If `.codegraph/` is absent:** The session-start hook surfaces a one-time suggestion:

> "This project doesn't have CodeGraph initialized. Running `codegraph init -i` would let Clank navigate your codebase more accurately and use significantly fewer tokens. Want me to run it now?"

Shown once per project; tracked in `.clank/config.json`.

Fallback when CodeGraph is absent: `Grep` and `Glob` for file/symbol discovery. Noted in the report.

---

## Report Schema

All reports live in `clank_reports/` in the user's project. Report IDs are `{mode}-{YYYYMMDD}-{HHMMSS}`.

```markdown
---
id: audit-20260320-143022
mode: audit
scope: src/utils/parser.ts
stack: typescript/vitest
created_at: 2026-03-20T14:30:22Z
status: complete
based_on: null  # or prior report ID for watch/bootstrap
---

# Clank {Mode} Report

## Scope
...

## Findings
(mode-specific sections)

## Metrics
...

## Recommended Actions
1. ...

## Raw Data
<!-- structured data for agent consumption -->
```

**Cross-report references:** Bootstrap and watch reports include `based_on: {prior-audit-id}` to create a traceable chain.

**`bin/clank-tools.cjs`** indexes reports and exposes:
- `clank-tools report-id {mode}` — generate a new timestamped ID
- `clank-tools recent {n}` — list n most recent reports with summaries
- `clank-tools detect-stack` — detect language, framework, test runner
- `clank-tools codegraph-present` — check for `.codegraph/`

---

## Behavior-Preservation Contract

Defined in `clank/references/behavior-preservation.md`. Read by every agent that writes code or tests. Non-negotiable.

1. **Baseline first.** Run the full test suite before any changes. If broken, stop and report. Never start from a broken baseline.
2. **Atomic changes.** Each file or function changed is a separate, independently-verifiable unit.
3. **Verify after each unit.** Re-run affected tests after each change. If anything that was passing now fails — revert immediately, document in report, continue to next unit.
4. **Report failures, never suppress.** If a change can't be made safely, the report says why. The user decides next steps.
5. **Bootstrap is additive only.** New test files only. No existing test file is ever modified by bootstrap.
6. **Refactor is structural only.** No changes to what is being tested, only how it is organized.

---

## Testing Philosophy

Defined in `clank/references/testing-philosophy.md`. Read by every agent that writes or evaluates tests. Violations block a report from being marked `status: complete`.

Sourced from foundational literature:

| Rule | Source |
|------|--------|
| One concept per test | Osherove — *The Art of Unit Testing* |
| Test behavior not implementation | Freeman & Pryce — *GOOS* |
| Tests must be readable as documentation | Beck — *TDD By Example* |
| No logic in tests (loops, conditionals) | Osherove |
| Arrange-Act-Assert structure, always | Meszaros — *xUnit Test Patterns* |
| Mock only at architectural boundaries | Freeman & Pryce |
| A test that can't fail is worse than no test | Beck |
| Characterization tests before refactoring legacy | Feathers — *Working Effectively with Legacy Code* |
| Test names describe behavior in plain language | Osherove |
| Tests are first-class code — same quality standards | Martin — *Clean Code* |
| Deep, simple interfaces over shallow, complex ones | Ousterhout — *A Philosophy of Software Design* |

---

## Stack Detection

Defined in `clank/references/stack-detection.md`. Detection order:

1. Check for `package.json` → Node/TypeScript; inspect `devDependencies` for test runner (vitest, jest, mocha, jasmine)
2. Check for `pyproject.toml` / `requirements.txt` → Python; look for pytest, unittest
3. Check for `Cargo.toml` → Rust; `cargo test` is standard
4. Check for `go.mod` → Go; `go test ./...` is standard
5. Check for `mix.exs` → Elixir; ExUnit
6. Fallback: ask the user

Stack information is written to every report's frontmatter and used by agents to generate idiomatic tests.

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

---

## `.clank/config.json` State

Tracked per-project:

```json
{
  "codegraph_suggestion_shown": false,
  "last_audit": "audit-20260320-143022",
  "last_bootstrap": null,
  "last_refactor": null,
  "last_watch": null
}
```

---

## Anti-Patterns Reference

`clank/references/anti-patterns.md` catalogs test smells the audit agent detects:

- Testing implementation details (asserting on private state, mocking internals)
- Logic in tests (conditionals, loops)
- Multiple concepts per test
- Tests that always pass (no assertion, wrong exception type caught)
- Unclear test names ("test1", "works correctly", "handles error")
- Excessive mocking hiding real behavior
- Fixture data that changes between runs (time, random values) without seeding
- Tests that depend on execution order
- Dead tests (commented out, never run, always skipped)
- Giant setup blocks that obscure what is being tested

---

## Open Questions (deferred to implementation)

- Should `watch` mode run automatically on `git commit` via a hook, or only on-demand?
- Should bootstrap tests be committed immediately or held in a staging area for review?
- Report retention policy — does Clank ever prune old reports, or is that left to the user?
