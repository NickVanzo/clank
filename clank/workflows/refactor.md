# Refactor Workflow

## Role

Orchestrator for refactor mode. Checks the baseline, gets approval, then runs
units sequentially with journal tracking. Reverts any unit that causes a
regression. Never modifies production code.

## Required reading

Read all three references before starting:

1. `~/.claude/clank/references/scope-resolution.md`
2. `~/.claude/clank/references/report-schema.md`
3. `~/.claude/clank/references/behavior-preservation.md`

## Step 1 — Scope + intent

Ask the user:

- What to refactor (file, directory, or test area)
- What kind of improvements are wanted (deduplication, renaming, fixture
  extraction, reorganization, parameterization)

## Step 2 — Initialize

```bash
RUN_ID=$(node ~/.claude/clank/bin/clank-tools.cjs report-id refactor)
SCRATCH=$(node ~/.claude/clank/bin/clank-tools.cjs scratch-init $RUN_ID)
```

## Step 3 — Baseline check

Run `{test_run_command}`. If the exit code is non-zero or there is a compilation
failure, write a report with `status: blocked` and stop. Never proceed from a
broken baseline.

## Step 4 — Plan units

Analyze the scope. Produce a list of units. Each unit must have:

```json
{
  "file": "<path to test file>",
  "description": "<exact description of the structural change>",
  "type": "deduplicate|rename|extract-fixture|reorganize|parameterize"
}
```

## Step 5 — Plan report

Write the plan report using the refactor-report.md template with
`status: awaiting_approval`.

Create `.clank/journals/refactor-${RUN_ID}.json` with all units set to
`pending`.

## Step 6 — Approval gate

Present the plan summary to the user. Ask: "Approve this plan?"

Wait for explicit approval before proceeding. On approval, update the report to
`status: in_progress`.

## Step 7 — Sequential execution

For each pending unit in the journal, spawn one `clank-refactorer` subagent.
Pass:

- `journal_path`: path to the journal file
- `unit_index`: index of this unit
- `unit`: the unit object
- `test_run_command`: the test command

Wait for the subagent to complete before starting the next unit. Update the
journal after each unit completes. Process units one at a time.

## Step 8 — Finalize

Merge all unit results. If any units have `status: reverted`, set the report
`status: partial`. Otherwise set `status: complete`.

Write the final report to `clank_reports/${RUN_ID}.md`.

```bash
node ~/.claude/clank/bin/clank-tools.cjs config-set last_refactor '"'$RUN_ID'"'
node ~/.claude/clank/bin/clank-tools.cjs scratch-clean $RUN_ID
```

## Step 9 — Record in memory graph

Before presenting results, call `mcp__clank__clank_memory_scope` for each file in `scope_paths` to retrieve all `open` finding IDs for those files. Compare the finding descriptions against what the refactor actually changed. Finding IDs whose described issue is no longer present are resolved.

Call `mcp__clank__clank_memory_record` with:
- `mode: "refactor"`
- `findings: []` (refactor does not produce new findings)
- `resolved_finding_ids`: array of finding IDs that are no longer present

If the call fails, append a warning to the report and continue.

## Step 10 — Present results

Show the user:

- Units completed successfully
- Units reverted, with the reason for each reversion
- Path to the full report
- Path to the journal at `.clank/journals/refactor-${RUN_ID}.json`
