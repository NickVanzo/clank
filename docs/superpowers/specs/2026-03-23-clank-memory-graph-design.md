# Clank Memory Graph

**Date:** 2026-03-23
**Status:** Draft
**Author:** Nick

---

## Overview

Clank currently stores run history as Markdown files in `clank_reports/`. Loading these files into agent context is expensive — the session-start hook scans every `.md` file, and agents reading prior runs for baseline or scope context must load full report bodies.

This spec replaces that mechanism with a **SQLite graph database** and an **MCP server**, modeled directly on CodeGraph's architecture. The user-facing commands (`/clank:audit`, `/clank:watch`, etc.) are unchanged. The graph is an invisible implementation detail.

---

## Goals

- Eliminate full Markdown report reads from the common agent paths
- Give agents instant, targeted memory queries (by scope, by run, by baseline)
- Mirror CodeGraph's proven architecture: SQLite graph + MCP server + interactive installer
- Keep Markdown reports as the human-readable archive — they are never removed

## Non-Goals

- No new user-facing commands
- No change to report format or the four Clank modes
- No vector embeddings (Clank's data is structured; semantic search is not needed)
- No incremental re-indexing hooks (graph is written explicitly at run completion, not derived from file changes)

---

## Architecture

```
user runs /clank:audit
    │
    ├── orchestrator spawns subagents (unchanged)
    ├── subagents write scratch files (unchanged)
    ├── orchestrator assembles clank_reports/audit-{ID}.md (unchanged)
    │
    └── orchestrator calls mcp__clank__clank_memory_record
            │
            └── clank MCP server writes to .clank/memory.db
                  (run node + finding nodes + scope nodes + edges)

session starts
    │
    └── SessionStart hook: clank memory-summary
            │
            └── queries .clank/memory.db → outputs compact summary to context

agent needs prior context mid-run
    │
    ├── mcp__clank__clank_memory_scope("src/parser.ts")   → finding history
    ├── mcp__clank__clank_memory_baseline(["src/"])        → best prior audit
    └── mcp__clank__clank_memory_run("audit-...")          → full run detail
```

**Distribution:** Clank is published as an npm package. `npx clank` runs the interactive installer, which registers the MCP server in `~/.claude.json` and configures permissions and hooks in `settings.json` — identical to how CodeGraph is distributed and installed.

---

## Graph Schema

`.clank/memory.db` — SQLite, one per project.

```sql
CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,    -- "run" | "finding" | "scope"
  data       TEXT NOT NULL,    -- JSON payload, shape depends on kind
  created_at INTEGER NOT NULL  -- unix ms
);

CREATE TABLE edges (
  source  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  -- "covers"    run → scope      (this run analyzed this path)
  -- "produced"  run → finding    (this run found this issue)
  -- "affects"   finding → scope  (this finding is about this path)
  -- "based_on"  run → run        (watch → prior audit)
  -- "resolved"  run → finding    (refactor run that fixed this)
  PRIMARY KEY (source, target, kind)
);

CREATE INDEX idx_nodes_kind    ON nodes(kind);
CREATE INDEX idx_edges_source  ON edges(source, kind);
CREATE INDEX idx_edges_target  ON edges(target, kind);
```

### Node payloads

**`run` node:**
```json
{
  "id": "audit-20260320-143022-001",
  "mode": "audit",
  "status": "complete",
  "scope_type": "directory",
  "scope_paths": ["src/utils/"],
  "stack": "typescript/vitest",
  "metrics": { "files": 12, "covered_functions": 34, "total_functions": 41 },
  "report_path": "clank_reports/audit-20260320-143022-001.md"
}
```

**`finding` node:**
```json
{
  "id": "f-audit-20260320-143022-001-0",
  "run_id": "audit-20260320-143022-001",
  "scope_path": "src/utils/parser.ts",
  "severity": "blocking",
  "kind": "anti_pattern",
  "text": "Missing null check on line 42",
  "status": "open"
}
```

**`scope` node:**
```json
{
  "id": "scope:src/utils/parser.ts",
  "path": "src/utils/parser.ts",
  "type": "file"
}
```

Scope nodes are **upserted** — created on first coverage, accumulate edges across runs. The scope node ID is `scope:{path}`.

---

## MCP Tools

Five tools. The server is registered as `clank` in `~/.claude.json`; tools are accessed as `mcp__clank__clank_memory_*`.

### `clank_memory_record`

Called by the orchestrator at the end of every run. Writes all graph mutations atomically.

**Input:**
```json
{
  "run": {
    "id": "audit-20260320-143022-001",
    "mode": "audit",
    "status": "complete",
    "scope_type": "directory",
    "scope_paths": ["src/utils/"],
    "stack": "typescript/vitest",
    "metrics": { "files": 12, "covered_functions": 34, "total_functions": 41 },
    "report_path": "clank_reports/audit-20260320-143022-001.md",
    "based_on": null
  },
  "findings": [
    {
      "id": "f-audit-20260320-143022-001-0",
      "scope_path": "src/utils/parser.ts",
      "severity": "blocking",
      "kind": "anti_pattern",
      "text": "Missing null check on line 42"
    }
  ],
  "resolved_finding_ids": []
}
```

**Graph mutations (single transaction):**
1. Upsert scope nodes for each path in `scope_paths` and each `finding.scope_path`
2. Insert run node
3. Insert finding nodes
4. Insert edges: `run→covers→scope`, `run→produced→finding`, `finding→affects→scope`
5. If `based_on` is set: insert `run→based_on→prior_run`
6. For each ID in `resolved_finding_ids`: insert `run→resolved→finding`, update finding node `status → "resolved"`

### `clank_memory_summary`

Compact overview for session-start context. Also callable via `clank memory-summary` CLI.

**Output:**
```json
{
  "recent_runs": [
    {
      "id": "audit-20260320-143022-001",
      "mode": "audit",
      "status": "complete",
      "created_at": "2026-03-20",
      "metrics": { "files": 12, "covered_functions": 34, "total_functions": 41, "coverage_pct": 82 }
    }
  ],
  "open_findings": {
    "total": 5,
    "blocking": 3,
    "by_scope": {
      "src/utils/parser.ts": 2,
      "src/utils/format.ts": 1
    }
  }
}
```

### `clank_memory_scope`

Targeted finding history for a path. Called by subagents before analyzing a file.

**Input:** `{ "path": "src/utils/parser.ts" }`

**Output:**
```json
{
  "scope": "src/utils/parser.ts",
  "covered_by": [
    { "run_id": "audit-20260320-143022-001", "created_at": "2026-03-20", "status": "complete" }
  ],
  "findings": [
    {
      "id": "f-audit-20260320-143022-001-0",
      "severity": "blocking",
      "kind": "anti_pattern",
      "text": "Missing null check on line 42",
      "status": "open",
      "found_in": "audit-20260320-143022-001",
      "created_at": "2026-03-20"
    }
  ]
}
```

### `clank_memory_baseline`

Finds the best prior audit to use as a watch baseline. Returns the most recent `complete` audit whose `scope_paths` cover all requested paths.

**Input:** `{ "scope_paths": ["src/"] }`

**Output:**
```json
{
  "run_id": "audit-20260320-143022-001",
  "created_at": "2026-03-20T14:30:22Z",
  "metrics": { "files": 12, "covered_functions": 34, "total_functions": 41 },
  "report_path": "clank_reports/audit-20260320-143022-001.md"
}
```

A run covers a requested path P if a `run→covers→scope` edge exists where the scope node's path is P or an ancestor of P (i.e., a directory whose path is a prefix of P). For example, a run that analyzed `src/` covers the requested path `src/utils/parser.ts` because `src/` is an ancestor of `src/utils/parser.ts`. A run that analyzed only `src/utils/` does not cover the requested path `src/`.

Returns `null` if no suitable baseline exists — watch mode then runs an inline audit first (existing behavior, unchanged).

### `clank_memory_run`

Full run detail including all findings. Used when an agent needs more than summary data.

**Input:** `{ "run_id": "audit-20260320-143022-001" }`

**Output:**
```json
{
  "run": {
    "id": "audit-20260320-143022-001",
    "mode": "audit",
    "status": "complete",
    "scope_type": "directory",
    "scope_paths": ["src/utils/"],
    "stack": "typescript/vitest",
    "metrics": { "files": 12, "covered_functions": 34, "total_functions": 41 },
    "report_path": "clank_reports/audit-20260320-143022-001.md",
    "based_on": null
  },
  "findings": [
    {
      "id": "f-audit-20260320-143022-001-0",
      "scope_path": "src/utils/parser.ts",
      "severity": "blocking",
      "kind": "anti_pattern",
      "text": "Missing null check on line 42",
      "status": "open",
      "resolved_by": null
    }
  ],
  "scopes_covered": ["src/utils/parser.ts", "src/utils/format.ts"]
}
```

The `report_path` field is included so the agent can open the `.md` if it needs narrative detail — the Markdown file remains the last resort, not the first.

---

## Write Path

```
run completes
  │
  ├── write clank_reports/{mode}-{ID}.md           (unchanged)
  │
  └── call mcp__clank__clank_memory_record(...)
        │
        └── MCP server:
              BEGIN TRANSACTION
                upsert scope nodes
                insert run node
                insert finding nodes
                insert edges
                update resolved finding statuses
              COMMIT
```

If the MCP call fails, the Markdown report still exists — the run is not lost, only the graph entry. The orchestrator logs a warning in the report body if `clank_memory_record` fails.

---

## Read Paths

### Session-start
```
SessionStart hook fires
  → clank memory-summary   (CLI, queries memory.db)
  → compact JSON → formatted bullet list printed to context
  (no .md files scanned)
```

### Watch finding its baseline
```
/clank:watch starts
  → mcp__clank__clank_memory_baseline({ scope_paths: [...] })
  → returns run_id + report_path
  → agent calls mcp__clank__clank_memory_run if it needs finding detail
  → reads .md only if narrative context is required
```

### Subagent loading prior context for a file
```
subagent assigned src/utils/parser.ts
  → mcp__clank__clank_memory_scope({ path: "src/utils/parser.ts" })
  → returns finding history in one small JSON blob
  → no .md file read
```

### Full run detail (rare)
```
agent needs complete prior run narrative
  → mcp__clank__clank_memory_run({ run_id: "..." })
  → if still insufficient: open report_path from result
  (.md is the last resort)
```

---

## Installation

Mirrors CodeGraph's installer exactly.

```bash
npx clank       # interactive installer
# or
npm install -g clank
```

### Installer steps

**1. Prompt: global or local install**
- Global → `~/.claude.json` + `~/.claude/settings.json`
- Local → `./.claude.json` + `./.claude/settings.json`

**2. Global npm install** (always runs regardless of install location — installs both the `clank` MCP server binary and the `clank-tools` CLI binary to PATH)
```bash
npm install -g clank
```
The `clank` npm package exports two binaries: `clank` (the MCP server, invoked as `clank serve --mcp`) and `clank-tools` (the existing CLI utility, extended with the new `memory-summary` command).

**3. Write MCP server config → `claude.json`**
```json
{
  "mcpServers": {
    "clank": {
      "type": "stdio",
      "command": "clank",
      "args": ["serve", "--mcp"]
    }
  }
}
```

**4. Prompt: auto-allow permissions → `settings.json`**
```json
{
  "permissions": {
    "allow": [
      "mcp__clank__clank_memory_record",
      "mcp__clank__clank_memory_summary",
      "mcp__clank__clank_memory_scope",
      "mcp__clank__clank_memory_baseline",
      "mcp__clank__clank_memory_run"
    ]
  }
}
```

**5. Write SessionStart hook → `settings.json`**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "clank-tools memory-summary" }]
      }
    ]
  }
}
```

Replaces the existing bash `session-start` hook file. The hook calls `clank-tools memory-summary`, a new command added to the existing `clank-tools` binary. No `PostToolUse`/`Stop` hooks needed — the graph is written explicitly at run completion, not derived from file change events.

**6. Write CLAUDE.md section**

Appended/updated in `~/.claude/CLAUDE.md` (global) or `./.claude/CLAUDE.md` (local). Instructs agents which MCP tools to use and when.

**7. Project init (local installs)**

Creates `.clank/` directory and initializes `memory.db` with the schema. No indexing phase — the DB starts empty and fills as runs complete.

---

## Changes to Existing Code

### All mode workflows (audit, bootstrap, refactor, watch)

One addition at run completion: call `mcp__clank__clank_memory_record` after writing the Markdown report. No other changes to workflow logic. Audit, bootstrap, and watch modes always pass `resolved_finding_ids: []` — only refactor mode populates this field.

### Watch mode

Replace `clank-tools recent` scan + report read with `mcp__clank__clank_memory_baseline`. Behavior identical; one MCP call replaces a file scan.

### Refactor mode

After the refactor completes, the orchestrator calls `clank_memory_scope` for each file in `scope_paths` to retrieve all `open` finding IDs for those files. It then calls `clank_memory_record` with `resolved_finding_ids` set to the IDs of findings whose described issue is no longer present — determined by re-running the audit agent inline on the touched files and comparing the new finding list against the prior one. Findings absent from the new list are considered resolved. The graph marks these `resolved` with the refactor run as the resolver.

### `clank-tools` CLI

**New command:** `clank-tools memory-summary` — queries `memory.db`, outputs the same JSON as `clank_memory_summary`. Used by the SessionStart hook (hooks cannot invoke MCP tools directly). If `memory.db` does not exist, falls back to `clank-tools recent` behavior (scan `.md` files) so the hook degrades gracefully on projects that have not yet run a Clank session since the upgrade.

**Deprecated:** `clank-tools recent` — kept as an internal fallback. No longer called directly by hooks or workflows.

### `hooks/session-start`

The bash file is replaced by the `SessionStart` hook entry written by the installer. The file can be removed from the repo once the installer handles it.

---

## Decisions

- **Backfill:** No backfill in v1. Projects upgrading from the old system start with an empty graph; history populates as new runs complete. The session-start hook falls back to scanning `.md` files until the first new run is recorded.
- **Retention:** Finding nodes are kept indefinitely. No pruning in v1.
- **`.gitignore`:** The installer always adds `.clank/memory.db` to the project `.gitignore`. The DB is local state; the Markdown reports in `clank_reports/` are the portable artifact and remain committed.
- **MCP error responses:** On tool failure, the MCP server returns a standard MCP protocol error. Orchestrators treat a failed `clank_memory_record` as non-fatal — the run is complete, the Markdown report exists, and a warning is appended to the report body.
