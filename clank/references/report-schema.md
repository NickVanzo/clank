# Clank Report Schema Reference

This document is required reading for all Clank agents and workflows. Every report written or
consumed by clank tooling must conform to the schemas defined here.

---

## 1. Frontmatter Block

Every report begins with a YAML frontmatter block containing these required fields:

```yaml
---
id: audit-20260320-143022-001
mode: audit
scope: '{"type":"directory","paths":["src/api/"],"symbols":[]}'
stack: typescript/vitest
codegraph_confidence: high
created_at: 2026-03-20T14:30:22Z
status: awaiting_approval
based_on: null
---
```

| Field | Type | Values |
|---|---|---|
| `id` | string | `{mode}-YYYYMMDD-HHmmss-NNN` (zero-padded 3-digit sequence) |
| `mode` | string | `audit` \| `bootstrap` \| `refactor` \| `watch` |
| `scope` | string | Inline JSON on ONE line — see Section 2 |
| `stack` | string | e.g. `typescript/vitest`, `python/pytest` |
| `codegraph_confidence` | string | `high` \| `low` \| `stale` — see Section 8 |
| `created_at` | string | ISO 8601 timestamp |
| `status` | string | See Section 3 |
| `based_on` | string \| null | ID of prior report this extends, or `null` |

`scope` MUST be stored as an inline JSON string on a single line. Do not use YAML block scalars
or multi-line values. This avoids multi-line YAML parsing ambiguity in agent tooling.

---

## 2. Scope JSON Object Schema

The value of the `scope` frontmatter field, when parsed, must match:

```json
{
  "type": "file | directory | function | project",
  "paths": ["string"],
  "symbols": ["string"]
}
```

Rules:
- `type` — one of `file`, `directory`, `function`, `project`.
- `paths` — always an array, even when targeting a single path.
- `symbols` — populated only for `function`-level scope; empty array `[]` otherwise.

Examples:

```json
{"type":"project","paths":["."],"symbols":[]}
{"type":"directory","paths":["src/api/","src/utils/"],"symbols":[]}
{"type":"file","paths":["src/api/handler.ts"],"symbols":[]}
{"type":"function","paths":["src/api/handler.ts"],"symbols":["handleRequest"]}
```

---

## 3. Status Lifecycle

```
awaiting_approval → in_progress → complete
                               → partial    (some units reverted)
                  → corrupt     (read-only sentinel; write interrupted or parse error)
```

| Status | Description |
|---|---|
| `awaiting_approval` | Report written; waiting for human or orchestrator approval to proceed |
| `in_progress` | Execution has started |
| `complete` | All units finished successfully |
| `partial` | Execution finished but some units were reverted (see refactor findings) |
| `corrupt` | Write was interrupted or frontmatter failed to parse |

`corrupt` is a **read-only sentinel** — clank-tools validate and set it; agents must never write
it directly. Reports with `status: corrupt` are skipped in `recent` output and excluded from
`based_on` chain lookups.

---

## 4. Scratch File Format

Each subagent writes ONE JSON file to `.clank/scratch/{run-id}/{agent-index}.json` upon
completion or error.

```json
{
  "agent_index": 0,
  "scope": {"type": "directory", "paths": ["src/utils/"], "symbols": []},
  "status": "complete | error",
  "findings": [],
  "error": null
}
```

| Field | Type | Description |
|---|---|---|
| `agent_index` | number | Zero-based index matching the agent's position in the run |
| `scope` | object | The scope this agent was assigned (parsed JSON, not string) |
| `status` | string | `complete` or `error` |
| `findings` | array | Mode-specific finding objects — see Section 5 |
| `error` | string \| null | Error message if `status` is `error`; `null` otherwise |

The orchestrator aggregates all scratch files into the final report's Raw Data section.

---

## 5. Findings Array Item Schema (per mode)

### Audit

```json
{
  "type": "gap | anti-pattern | redundancy",
  "file": "src/utils/parser.ts",
  "symbol": "parseDate",
  "description": "No test exercises the null input branch",
  "severity": "blocking | advisory",
  "confidence": "high | low"
}
```

| Field | Values | Description |
|---|---|---|
| `type` | `gap` \| `anti-pattern` \| `redundancy` | Category of finding |
| `file` | string | Repo-relative path |
| `symbol` | string | Function or class name; empty string if file-level |
| `description` | string | Actionable description of the issue |
| `severity` | `blocking` \| `advisory` | `blocking` findings must be resolved before bootstrap proceeds |
| `confidence` | `high` \| `low` | Reflects `codegraph_confidence` at time of finding |

### Bootstrap

```json
{
  "file": "src/utils/parser.ts",
  "tests_written": 5,
  "requires_manual": ["parseExternalDate"],
  "suspected_defects": ["parseDate returns wrong result for negative timestamps"]
}
```

| Field | Type | Description |
|---|---|---|
| `file` | string | Source file tests were written for |
| `tests_written` | number | Count of test cases written in this run |
| `requires_manual` | string[] | Symbols that need human-authored tests (e.g. external I/O) |
| `suspected_defects` | string[] | Behaviors observed that suggest bugs in the source under test |

### Refactor

```json
{
  "unit_index": 0,
  "file": "tests/utils/parser.test.ts",
  "status": "done | reverted",
  "reason": "regression in suite after applying rename"
}
```

| Field | Type | Description |
|---|---|---|
| `unit_index` | number | Zero-based index of the refactor unit in the plan |
| `file` | string | Test file that was modified |
| `status` | `done` \| `reverted` | `reverted` means the change was rolled back |
| `reason` | string | Why the unit was reverted; empty string if `done` |

### Watch

```json
{
  "drift_type": "new_file | signature_change | dead_reference",
  "file": "src/api/newHandler.ts",
  "symbol": "handleRequest",
  "description": "New file with no corresponding test file",
  "priority": "high | medium | low"
}
```

| Field | Values | Description |
|---|---|---|
| `drift_type` | `new_file` \| `signature_change` \| `dead_reference` | Category of drift |
| `file` | string | File where drift was detected |
| `symbol` | string | Symbol involved; empty string if file-level |
| `description` | string | Actionable description of the drift |
| `priority` | `high` \| `medium` \| `low` | Urgency of addressing this drift |

---

## 6. clank-tools `recent` JSON Output Schema

`clank-tools recent` returns a JSON array. Each element:

```json
{
  "id": "audit-20260320-143022-001",
  "mode": "audit",
  "status": "complete",
  "scope": "{\"type\":\"project\",\"paths\":[\".\"],\"symbols\":[]}",
  "created_at": "2026-03-20T14:30:22Z",
  "summary": "First 200 chars of Recommended Actions or first body line"
}
```

| Field | Description |
|---|---|
| `id` | Report ID from frontmatter |
| `mode` | Report mode |
| `status` | Report status — `corrupt` reports are excluded |
| `scope` | Raw scope string from frontmatter (still JSON-encoded) |
| `created_at` | ISO 8601 timestamp |
| `summary` | First 200 characters of the Recommended Actions section, or first non-empty body line |

---

## 7. Section Structure

All report bodies (below the frontmatter) must follow this section order:

1. **Scope** — restate scope in prose; note any adjustments from the requested scope
2. **Findings** — mode-specific subsections (e.g. `### Gaps`, `### Anti-patterns`)
3. **Metrics** — quantitative summary (files scanned, tests written, units reverted, etc.)
4. **Recommended Actions** — ordered, actionable steps; this section feeds the `summary` field
5. **Raw Data** — fenced JSON block containing the aggregated scratch data for agent consumption

Agents reading a report programmatically may parse the Raw Data block without parsing prose
sections. The Raw Data block must be valid JSON.

---

## 8. codegraph_confidence Values

| Value | Condition |
|---|---|
| `high` | CodeGraph is present AND fresh (`commits_since` < 10) |
| `low` | No CodeGraph present; analysis used Grep/Glob fallback |
| `stale` | CodeGraph is present but outdated (`commits_since` >= 10) |

Tag findings and Raw Data entries with their confidence level at the time of analysis. When
confidence is `low` or `stale`, note the fallback method used in the finding's `description`.
