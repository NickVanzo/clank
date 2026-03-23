# Watch Workflow

## Role

Orchestrator for watch mode. Detects drift between the current production code
and the test suite, measured against a baseline audit report. Never reads
source or test files directly. Delegates all analysis to a `clank-watcher`
subagent. Assembles and writes the final watch report.

## Required reading

Read both references before starting:

1. `~/.claude/clank/references/scope-resolution.md`
2. `~/.claude/clank/references/report-schema.md`

## Step 1 — Scope

Follow `scope-resolution.md` to ask the user what to watch. Default to full
project if the user provides no input. Resolve the answer to a scope object
(list of paths and optional function names).

## Step 2 — Baseline check

Call `mcp__clank__clank_memory_baseline` with `scope_paths` from the resolved scope object.

If a baseline is returned: use the returned `run_id` as the baseline. If the agent also needs the full findings list from that run, call `mcp__clank__clank_memory_run` with that `run_id`. Only read the `.md` file at `report_path` if you need the narrative detail not available in the graph.

If `null` is returned (no matching audit in the graph): fall back to the existing `.md` scan behaviour — call `clank-tools recent 5`, find the most recent audit whose scope covers the current watch scope.

If no baseline is found by either method, run a lightweight inline audit first:

- Spawn a single `clank-auditor` subagent covering the full project scope
- No parallelism — one agent only
- Wait for it to complete and write its report

Use that inline audit report as the baseline. Note `based_on: {inline-audit-id}` in the watch report.

Also update **Step 5** to call `mcp__clank__clank_memory_record` after writing the report, with `based_on` set to the baseline run ID.

## Step 3 — Initialize

```bash
RUN_ID=$(node ~/.claude/clank/bin/clank-tools.cjs report-id watch)
SCRATCH=$(node ~/.claude/clank/bin/clank-tools.cjs scratch-init $RUN_ID)
```

## Step 4 — Spawn watcher

Spawn a single `clank-watcher` subagent with:

- `run_id`: the value of `$RUN_ID`
- `agent_index`: `0`
- `scratch_path`: the value of `$SCRATCH`
- `scope`: the resolved scope object from Step 1
- `baseline_report_path`: absolute path to the baseline report from Step 2

Wait for the subagent to complete before proceeding.

## Step 5 — Write report

Read `~/.claude/clank/templates/watch-report.md`. Fill in all `{{PLACEHOLDER}}`
values:

- `{{ID}}`: `$RUN_ID`
- `{{SCOPE_JSON}}`: the scope object as JSON
- `{{BASELINE_AUDIT_ID}}`: the baseline report ID from Step 2; if an inline
  audit was run, use that report's ID and set `based_on: {inline-audit-id}`
- `{{BASELINE_DATE}}`: creation date of the baseline report
- `{{FILES_DRIFTED}}`: count of unique files in findings
- `{{FUNCTIONS_DRIFTED}}`: count of findings with a `symbol` field
- `Raw Data.findings`: the findings array from the watcher's scratch output

Set `status: complete`. Write the completed report to:

```
clank_reports/${RUN_ID}.md
```

Then run cleanup:

```bash
node ~/.claude/clank/bin/clank-tools.cjs scratch-clean $RUN_ID
node ~/.claude/clank/bin/clank-tools.cjs config-set last_watch '"'$RUN_ID'"'
```

## Step 6 — Present

Group drift items by priority (high → medium → low) and list them for the
user. If the findings array is empty, report: "Suite is in sync — no drift
detected." Give the path to the full watch report.
