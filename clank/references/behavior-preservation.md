# Behavior Preservation Contract

This document is a non-negotiable contract read by every Clank agent that writes code or tests.
No agent may proceed with changes without satisfying these rules in full.

---

## The Six Rules

### 1. Baseline first

Run the full test suite before any changes. A "broken baseline" means a non-zero exit code
or compilation failure. Skipped and xfail tests do not block the baseline. If the baseline is
broken, stop and report immediately. Never start from a broken baseline.

### 2. Atomic changes

Each file or function changed is a separate, independently-verifiable unit tracked in the
journal. Do not bundle multiple changes into a single unit.

### 3. Full suite after each unit

Run the complete test suite — not a scoped subset — after each change. Scope determination is
unreliable; the full suite is the only safe verification. If a regression is found, revert the
unit immediately, mark it `reverted` in the journal, document it in the report, and continue
to the next unit.

### 4. Report failures, never suppress

If a change cannot be made safely, the report says why. The user decides next steps. Never
silently skip a unit or paper over a failure.

### 5. Bootstrap is additive only

New test files only. No existing test file is written by bootstrap. Subagents may read
existing test helpers to avoid fixture duplication.

### 6. Refactor is structural only

No changes to what is being tested — only how it is organized. No behavior modifications, no
new assertions, no deleted assertions.

---

## Definition of "Broken Baseline"

A baseline is broken when any of the following is true:

- The test runner exits with a non-zero exit code
- Compilation fails: type errors, build errors, or import resolution failures

A baseline is **not** broken by:

- Skipped tests
- `xfail` / `expectedFailure` / `pending` tests
- Tests marked to be skipped under specific conditions

If a test was already failing before the run started, that IS a broken baseline. There is no
distinction between "pre-existing failure" and "new failure" — a broken baseline is a broken
baseline.

---

## Rule 3 Clarification: Always Run the Full Suite

The full suite must be run after every atomic unit. No exceptions based on perceived scope.

**Explicitly forbidden:**

- Running only the test file you changed
- Running only tests that import the module you touched
- Using `--testPathPattern`, `--filter`, `-k`, or any equivalent flag to scope the runner
- Any heuristic like "I only changed X so I only need to test Y"

"Affected tests" is an unreliable heuristic. Do not use it.

**The only exception:** a user-configured `test_run_command` in `.clank/config.json`. That
command is treated as the full suite for this project and must be run verbatim.

---

## Rule 5 Clarification: Bootstrap Additive-Only

Subagents may read existing test helpers, fixture files, and factory functions to avoid
duplicating patterns. Reading is allowed; writing is not.

Subagents **must not** write to any file that already existed in the project at the time the
bootstrap run started. "Existing" means any file present in the working tree before
`clank bootstrap` runs — not just test files.

The list of existing files is captured at run start and enforced per-subagent. If a subagent
is unsure whether a file pre-existed, it must treat the file as existing and not write to it.

---

## What to Do on Regression

When a test that was passing before a change is now failing:

1. Immediately run `git restore {file}` to revert the changed file
2. Mark the unit as `reverted` in the journal with the reason
3. Log the regression in the report's Execution Log
4. Continue to the next pending unit — do not stop the entire run
5. The final report status will be `partial` if any units were reverted

Do not attempt to fix the regression by modifying other code. Revert and move on.

---

## What to Do on Broken Baseline

When the baseline check fails before any changes are made:

1. **Stop entirely** — do not proceed with any changes
2. Write a report with `status: blocked`
3. Include in the report:
   - The exact command that was run
   - The exit code returned
   - The last 20 lines of output
4. Do not create scratch directories or journal files for this run
5. Present the blocked report to the user

The user must resolve the broken baseline before a Clank run can proceed.
