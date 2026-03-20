# Clank

Clank is a Claude Code plugin for managing the full lifecycle of a test suite. It audits coverage, generates tests for untested code, refactors messy suites, and watches for drift — all without ever touching production code.

Every Clank operation produces a persistent Markdown report in `clank_reports/`. Nothing is changed without your explicit approval.

---

## What Clank does

Modern codebases accumulate test debt the same way they accumulate technical debt: gradually, invisibly, until a refactor breaks something you didn't know was untested. Clank gives you four tools to fight this:

- **Audit** — find what isn't tested, what's tested badly, and what's redundant
- **Bootstrap** — generate a first layer of tests for code that has none
- **Refactor** — clean up a messy suite without changing what it verifies
- **Watch** — detect when production changes have outpaced the tests

---

## Installation

```bash
node bin/install.js
```

This copies Clank's commands, agents, and tools into your Claude Code configuration, registers a session-start hook, and initializes a `.clank/` state directory in your project.

The installer places shared files in `~/.claude/clank/` so all projects on the same machine share one installation. Per-project version pinning is not supported in v0.1.

---

## Commands

### `/clank:audit` — Find what's wrong with your test suite

Audit analyzes a scope you choose — the full project, a directory, specific files, or a single function — and produces a findings report covering three areas:

**Coverage gaps** — public functions and methods with no test that exercises them. Clank maps every exported symbol in scope and checks whether any test file calls it by name. Each gap is reported with a severity: `blocking` (critical path, no coverage) or `advisory` (utility code, low risk).

**Anti-patterns** — test smells that make your suite brittle, misleading, or impossible to maintain. Clank checks for 14 categories drawn from testing literature:

| Anti-pattern | Severity | What it means |
|---|---|---|
| Testing implementation details | Blocking | Assertions on private state; your tests break on refactors that don't change behavior |
| Logic in tests | Blocking | Loops or conditionals in test bodies; the test itself can have bugs |
| Multiple concepts per test | Blocking | One test failure tells you nothing useful |
| Tests that always pass | Blocking | Assertions in catch blocks or no assertions at all |
| Tautological assertions | Blocking | `expect(x).toBe(x)` — can never fail |
| Assertion roulette | Blocking | Multiple bare asserts with no context; you can't tell which one failed |
| Flaky tests | Blocking | `sleep()`, unseeded random, raw network calls, unordered collection iteration |
| Order-dependent tests | Blocking | Tests that only pass when run in a specific sequence |
| Unclear test names | Advisory | `test1`, `works correctly`, `handles error` |
| Excessive mocking | Advisory | Mocking so much that the test verifies mock behavior, not production behavior |
| Dead tests | Advisory | Commented out, always skipped with no explanation |
| Giant setup blocks | Advisory | `beforeEach` that does so much you can't see what's being tested |
| Fixture data without seeding | Advisory | `new Date()` or `random()` in fixture setup |
| Characterization tests without naming convention | Advisory | Tests that capture legacy behavior but aren't labeled as such |

**Redundancy** — duplicate coverage that adds maintenance burden without adding safety.

The report is written to `clank_reports/audit-{ID}.md` before any summary is shown to you. You can re-read it any time.

---

### `/clank:bootstrap` — Generate tests for untested code

Bootstrap reads your production code, infers what each exported function does from its implementation, and writes characterization tests — tests that describe what the code currently does, not what it ideally should do.

**Characterization tests** are a technique from Michael Feathers' *Working Effectively with Legacy Code*. They're safety nets, not specifications. Their purpose is to let you refactor safely by pinning the current behavior.

**How it works:**

1. You tell Clank what to cover (full project, a directory, or specific files) and how (full public API, happy paths, edge cases)
2. Clank analyzes your code and produces a test plan: every planned test with its function name, proposed test name, and what behavior it will verify
3. Clank writes a plan report (`status: awaiting_approval`) and presents it to you
4. **You approve or decline.** Nothing is written until you say yes.
5. On approval, Clank generates the test files

**Naming convention:** All generated tests start with `characterizes ` (Jest/Vitest) or `characterizes_` (Python) to signal their provisional nature.

**Suspected defects:** If Clank spots what looks like a bug — an off-by-one, a null not handled, an obvious logic error — it still generates a test capturing the current (possibly wrong) behavior, and marks it with a comment:

```
# CHARACTERIZATION: this test captures current behavior which may be incorrect — {reason}
```

The suspected defect is also listed in the report under "Suspected Defects" so you can decide whether to fix it.

**When Clank can't infer behavior:** If a function delegates entirely to an external service, depends on global mutable state, or requires running the code to observe its output, Clank skips it and lists it under "Functions Requiring Manual Characterization."

**Bootstrap is additive only.** Clank never writes to a file that already exists. Existing test helpers may be read to avoid duplicating fixtures, but never modified.

---

### `/clank:refactor` — Clean up your test suite structure

Refactor applies structural improvements to an existing suite — deduplication, renaming, fixture extraction, parameterization — without changing what any test verifies.

**Structural changes only.** No assertions are added, removed, or modified. No production code is touched. Refactor changes how your tests are organized, not what they check.

**Supported refactor types:**

- **Deduplicate** — consolidate near-identical tests into `test.each` / `@pytest.mark.parametrize`
- **Rename** — rename tests and describe blocks to accurately describe the behavior being tested
- **Extract fixtures** — pull repeated setup into shared helpers or fixtures
- **Reorganize** — group related tests into meaningful describe blocks
- **Parameterize** — convert repeated test variants into a single parameterized test

**How it works:**

1. You tell Clank what to refactor and what kind of improvements you want
2. Clank checks the baseline: runs your full test suite. **If the baseline is broken (non-zero exit or compilation failure), Clank stops and reports why. It will not start from a broken suite.**
3. Clank analyzes the scope and produces a plan: a list of units, each with the file, a description of the change, and the type of refactor
4. Clank writes a plan report (`status: awaiting_approval`) and presents it to you
5. **You approve or decline.** Nothing is changed until you say yes.
6. On approval, Clank executes units **one at a time**. After each change, the full suite runs. If a regression is detected, the change is immediately reverted with `git restore`, marked as `reverted` in the journal, and Clank moves on to the next unit.
7. The final report shows what was done, what was reverted, and why.

**The journal** (`.clank/journals/refactor-{ID}.json`) persists the state of each unit. If a session ends mid-refactor, a future session can resume from where it left off.

---

### `/clank:watch` — Detect drift between code and tests

Watch compares your current production code against a prior audit report as a baseline and surfaces what has fallen out of sync.

**Three drift types:**

- **New file** — a production file was added with no corresponding test file
- **Signature change** — a function's parameters, return type, or control flow changed since the baseline (whitespace and comment changes are ignored)
- **Dead reference** — a test references a production symbol that has been renamed or deleted

**How it works:**

1. You tell Clank what to watch (default: full project)
2. Clank finds the most recent audit report that covers the current scope. If none exists or the baseline is too narrow, Clank runs a lightweight inline audit first to establish one.
3. A `clank-watcher` subagent compares current production symbols against the baseline findings
4. Results are written to `clank_reports/watch-{ID}.md` with drift items sorted by priority

Watch never makes changes. It surfaces what needs attention.

---

## How scope works

Every Clank command starts by asking you what to analyze. There are no command-line flags — you describe the scope in plain language, and Clank resolves it.

**Examples of what you can say:**

- "the full project"
- "the src/api/ directory"
- "just src/utils/parser.ts"
- "the parseDate function in src/utils/parser.ts"

Clank resolves your answer to a formal scope object and stores it in the report frontmatter. If your answer is ambiguous, Clank asks a follow-up before proceeding — it never assumes a scope without confirming.

**Monorepo support:** For projects with multiple packages, Clank detects the language and test runner per path. If `packages/api/` uses Jest and `packages/web/` uses Vitest, findings are labeled separately for each stack.

---

## Language support

Clank detects the stack automatically by walking up from the scoped paths to the nearest manifest file.

| Language | Detection | Test runner |
|---|---|---|
| TypeScript | `package.json` with `typescript` in devDeps | vitest, jest, mocha, jasmine |
| JavaScript | `package.json` | vitest, jest, mocha, jasmine |
| Python | `pyproject.toml` or `requirements.txt` | pytest |
| Rust | `Cargo.toml` | cargo test |
| Go | `go.mod` | go test |
| Elixir | `mix.exs` | ExUnit |

---

## Reports

Every operation produces a Markdown report in `clank_reports/` in your project. Reports have a YAML frontmatter header:

```yaml
---
id: audit-20260320-143022-001
mode: audit
scope: '{"type":"directory","paths":["src/api/"],"symbols":[]}'
stack: typescript/vitest
codegraph_confidence: high
created_at: 2026-03-20T14:30:22Z
status: complete
based_on: null
---
```

**Report statuses:**

| Status | Meaning |
|---|---|
| `awaiting_approval` | Plan written; waiting for your go-ahead |
| `in_progress` | Approved; work underway |
| `complete` | Finished with no blocking issues |
| `partial` | Finished; some units were reverted or some agents errored |
| `blocked` | Could not start; baseline was broken |
| `corrupt` | File was interrupted mid-write; skipped in future queries |

**Querying reports:**

```bash
node ~/.claude/clank/bin/clank-tools.cjs recent 5
```

Returns a JSON array of the 5 most recent reports with id, mode, status, scope, created_at, and a summary excerpt.

---

## CodeGraph integration

If your project has CodeGraph initialized (`.codegraph/` directory present), Clank uses it as the primary navigation layer. This makes audits more accurate and uses significantly fewer tokens than Grep/Glob scanning.

| What Clank needs | Without CodeGraph | With CodeGraph |
|---|---|---|
| Find untested functions | Grep for symbol names in test files | `codegraph_search` by symbol type |
| Trace what a function calls | Read and parse source files | `codegraph_callees` |
| Find what calls a module | Grep across the whole codebase | `codegraph_callers` |
| Assess refactor blast radius | Manual reasoning | `codegraph_impact` |

Clank checks freshness before using CodeGraph. If significant commits have landed since the last index, it falls back to Grep/Glob and labels results `codegraph_confidence: stale`.

To initialize CodeGraph: `codegraph init -i`

Clank surfaces a one-time suggestion at session start if CodeGraph is absent.

---

## Project state

Clank stores per-project state in `.clank/`:

```
.clank/
├── config.json          # per-project settings
├── journals/
│   └── refactor-{ID}.json   # execution state for refactor runs
└── scratch/
    └── {run-id}/        # temporary; deleted after each run completes
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

If your suite takes more than a few minutes to run, set `test_run_command` to a scoped runner (e.g. `vitest run --project api`). Refactor will use it in place of the default full-suite command.

Add `.clank/scratch/` to your `.gitignore`. Commit `clank_reports/` and `.clank/config.json`.

---

## Testing philosophy

Clank's audit rules are drawn from seven books on software testing. The full citation list is in `clank/references/testing-philosophy.md`.

**Blocking violations** — the report cannot be marked `complete` while any of these are present:

- One concept per test (Osherove)
- Test behavior, not implementation (Freeman & Pryce)
- Tests must be readable as documentation (Beck)
- No logic in tests (Osherove)
- Arrange-Act-Assert structure, always (Meszaros)
- Mock only at architectural boundaries in unit tests (Freeman & Pryce)
- A test that can't fail is worse than no test (Beck)
- Characterization tests before refactoring legacy code (Feathers)
- Test names describe behavior in plain language (Osherove)
- Tests are first-class code — same quality standards (Martin)
- No assertion roulette (Meszaros)

**Advisory violations** — reported, but do not block completion:
- Test helpers expose one entry point, not a multi-object assembly (Ousterhout)
- Unclear test names
- Excessive mocking (evaluated per test layer)
- Dead tests
- Giant setup blocks
- Characterization tests without naming convention

---

## Architecture

Clank follows the GSD plugin architecture. Agent behavior lives in Markdown files; stateful operations (report IDs, stack detection, scratch management, config) go through `bin/clank-tools.cjs`.

```
commands/clank/     Entry points: /clank:audit, /clank:bootstrap, etc.
clank/workflows/    Full mode orchestration logic
agents/             Specialized subagents with YAML frontmatter
clank/references/   Shared knowledge consumed by all agents
clank/templates/    Report templates agents fill in
bin/                clank-tools.cjs (CLI), install.js
hooks/              session-start hook
```

Subagents communicate through scratch files (`.clank/scratch/{run-id}/{agent-index}.json`), not the agent API. The orchestrator merges scratch files after all subagents complete.

**Parallelism by mode:**

| Mode | Parallelism | Why |
|---|---|---|
| Audit | Parallel per module | Read-only; safe |
| Bootstrap | Parallel per file | Writes to new files only; no conflicts |
| Refactor | Sequential | Shared fixture writes conflict when parallel |
| Watch | Single agent | Lightweight |

---

## Contributing

Design spec: `docs/superpowers/specs/2026-03-20-clank-design.md`

Reference docs: `clank/references/` — these are the authoritative rules all agents follow. If you change behavior, update the relevant reference doc.
