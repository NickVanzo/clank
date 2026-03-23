## Role

Orchestrator for bootstrap mode. Produces a test plan report, waits for approval, then
spawns `clank-bootstrapper` subagents to write characterization tests.

## Required reading

Before starting, read:

1. `~/.claude/clank/references/scope-resolution.md`
2. `~/.claude/clank/references/report-schema.md`
3. `~/.claude/clank/references/stack-detection.md`
4. `~/.claude/clank/references/behavior-preservation.md`

---

## Step 1 — Scope + intent

Ask the user what to cover and how. Clarify:

- Which files, directories, or modules are in scope
- Coverage goal: full public API, happy paths only, or edge cases too
- Whether existing partial tests should be extended or only new files created

Do not proceed until scope is confirmed.

## Step 2 — Initialize run

Run:

```
clank-tools report-id bootstrap
clank-tools scratch-init
```

Store the returned `RUN_ID` and `scratch_path` for all subsequent steps.

## Step 3 — Analysis phase

For each file in scope, spawn a `clank-auditor` subagent to discover untested or
undertested exported functions. Subagents run in parallel. When all finish, merge their
results into a unified list of functions to characterize.

## Step 4 — Plan report

Write `clank_reports/${RUN_ID}.md` using the `bootstrap-report.md` template with
`status: awaiting_approval`.

The report must list, for every planned test:

- Function name and source file
- Proposed test name (must start with `characterizes `)
- Behavior description (one sentence)

Also list:

- `requires_manual` items: functions that cannot be inferred statically
- `suspected_defects`: any issues identified during analysis

## Step 5 — Approval gate

Present a summary to the user:

- Total files in scope
- Total planned tests
- Count of `requires_manual` items
- Count of `suspected_defects`

Ask: **"Approve this plan?"**

- If approved: update report `status: in_progress` and continue to Step 6.
- If declined: stop. Do not write any test files. The report remains at
  `status: awaiting_approval`.

## Step 6 — Bootstrap phase

For each file in scope:

1. Compute `test_file_path` following project conventions:
   - TypeScript/JavaScript: colocated `*.test.ts` / `*.test.js` next to the source file,
     unless the project uses a `tests/` mirror directory
   - Python: mirror path under `tests/` with `test_` prefix
2. Spawn one `clank-bootstrapper` subagent per file, passing `run_id`, `agent_index`,
   `scratch_path`, `target_file`, `stack`, and `test_file_path`.

Subagents run in parallel. Do not write test files yourself.

## Step 7 — Merge + finalize

When all subagents complete:

1. Read every `{scratch_path}/{agent_index}.json`.
2. Aggregate `tests_written`, `requires_manual`, and `suspected_defects` across all files.
3. Update `clank_reports/${RUN_ID}.md` with actuals and set `status: complete`.
4. Run `clank-tools config-set last_bootstrap ${RUN_ID}`.
5. Delete the scratch directory.

## Step 8 — Record in memory graph

After writing the final report, call `mcp__clank__clank_memory_record` with the same structure as the audit workflow. Set `mode: "bootstrap"`, `resolved_finding_ids: []`. Include one finding per file where tests were added, with `kind: "bootstrap_coverage"` and `status` implied open until an audit confirms coverage.

If the call fails, append a warning to the report and continue.

## Step 9 — Present results

Summarize to the user:

- Total tests generated across all files
- Any `suspected_defects` (list each with file, function, and reason)
- Any `requires_manual` items (list each so the user knows what needs hand-written tests)
