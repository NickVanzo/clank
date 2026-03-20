# Audit Workflow

## Role

Orchestrator for audit mode. Never reads source or test files directly. Delegates
all analysis to `clank-auditor` subagents. Assembles and writes the final report.

## Required reading

Read all three references before starting:

1. `~/.claude/clank/references/scope-resolution.md`
2. `~/.claude/clank/references/report-schema.md`
3. `~/.claude/clank/references/stack-detection.md`

## Step 1 — Scope resolution

Follow `scope-resolution.md` to ask the user what to audit. Resolve the answer to
a scope object (list of paths and optional function names). For each path in scope,
run stack detection:

```bash
node ~/.claude/clank/bin/clank-tools.cjs detect-stack <path>
```

## Step 2 — Initialize run

```bash
RUN_ID=$(node ~/.claude/clank/bin/clank-tools.cjs report-id audit)
SCRATCH=$(node ~/.claude/clank/bin/clank-tools.cjs scratch-init $RUN_ID)
```

## Step 3 — Check CodeGraph

```bash
node ~/.claude/clank/bin/clank-tools.cjs codegraph-fresh
```

Set `codegraph_confidence` from the result: `high` if fresh, `low` if absent or stale.

## Step 4 — Spawn subagents

For each module/directory in scope, spawn a `clank-auditor` subagent with:

- `run_id`: the value of `$RUN_ID`
- `agent_index`: integer starting at 0, incremented per subagent
- `scope`: the sub-scope object for this module
- `scratch_path`: the value of `$SCRATCH`

Spawn all subagents in parallel.

## Step 5 — Merge results

Wait for all subagents to complete, then merge their scratch files:

```bash
node ~/.claude/clank/bin/clank-tools.cjs scratch-merge $RUN_ID
```

## Step 6 — Write report

Read `~/.claude/clank/templates/audit-report.md`. Fill in all `{{PLACEHOLDER}}`
values using the merged results and run metadata. Write the completed report to:

```
clank_reports/${RUN_ID}.md
```

Set `status: complete` unless any subagent reported `status: error`, in which case
set `status: partial`.

## Step 7 — Cleanup

```bash
node ~/.claude/clank/bin/clank-tools.cjs scratch-clean $RUN_ID
node ~/.claude/clank/bin/clank-tools.cjs config-set last_audit '"'$RUN_ID'"'
```

## Step 8 — Present report

Summarize the key findings to the user (blocking violations, advisory count, top
coverage gaps). Give the path to the full report.
