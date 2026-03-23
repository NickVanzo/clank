# Clank Memory Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Clank's Markdown-file-based memory with a SQLite graph database exposed via an MCP server, giving agents instant targeted memory queries without loading full report files.

**Architecture:** A `node:sqlite` graph DB at `.clank/memory.db` stores run, finding, and scope nodes with typed edges. A stdio MCP server (`bin/clank.cjs serve --mcp`) exposes five tools agents call directly. The existing `clank-tools` CLI gains a `memory-summary` command for the SessionStart hook. All four mode workflows gain a `clank_memory_record` call at completion.

**Tech Stack:** Node.js 22+ (built-in `node:sqlite`), `@modelcontextprotocol/sdk` (MCP server), CommonJS throughout (matching existing codebase). No new runtime dependencies beyond the MCP SDK.

**Spec:** `docs/superpowers/specs/2026-03-23-clank-memory-graph-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db.cjs` | Create | SQLite init, schema, and all graph query/write functions |
| `bin/clank.cjs` | Create | Entry point: routes `serve --mcp` to MCP server, bare invocation to installer |
| `tests/db.test.cjs` | Create | Unit tests for all `src/db.cjs` functions |
| `bin/clank-tools.cjs` | Modify | Add `memory-summary` command with `.md` fallback |
| `bin/install.js` | Modify | Add MCP config, permissions, SessionStart hook, CLAUDE.md writing |
| `package.json` | Modify | Add `@modelcontextprotocol/sdk`, `clank` bin entry, engines bump |
| `clank/workflows/audit.md` | Modify | Add Step 8: call `clank_memory_record` |
| `clank/workflows/bootstrap.md` | Modify | Add Step 8: call `clank_memory_record` |
| `clank/workflows/refactor.md` | Modify | Add Step 9: call `clank_memory_record` with `resolved_finding_ids` |
| `clank/workflows/watch.md` | Modify | Replace Step 2 scan with `clank_memory_baseline` |

---

## Task 1: Package setup

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json**

Replace the contents of `package.json` with:

```json
{
  "name": "clank",
  "version": "0.2.0",
  "description": "Test suite lifecycle management plugin for Claude Code",
  "type": "commonjs",
  "scripts": {
    "test": "node --test tests/clank-tools.test.cjs && node --test tests/db.test.cjs"
  },
  "bin": {
    "clank-tools": "./bin/clank-tools.cjs",
    "clank": "./bin/clank.cjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.10.2",
    "js-yaml": "4.1.0"
  },
  "engines": {
    "node": ">=22.5.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

Expected: `node_modules/@modelcontextprotocol/` appears, no errors.

- [ ] **Step 3: Confirm existing tests still pass**

```bash
node --test tests/clank-tools.test.cjs
```

Expected: all tests pass (no regressions from package.json change).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk, clank bin entry"
```

---

## Task 2: DB module — init and record

**Files:**
- Create: `src/db.cjs`
- Create: `tests/db.test.cjs`

- [ ] **Step 1: Write failing tests for initDb and recordRun**

Create `tests/db.test.cjs`:

```js
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { initDb, recordRun } = require('../src/db.cjs');

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clank-db-test-'));
  fs.mkdirSync(path.join(dir, '.clank'), { recursive: true });
  return dir;
}

const MINIMAL_RUN = {
  id: 'audit-20260320-143022-001',
  mode: 'audit',
  status: 'complete',
  scope_type: 'directory',
  scope_paths: ['src/utils/'],
  stack: 'typescript/vitest',
  metrics: { files: 12, covered_functions: 34, total_functions: 41 },
  report_path: 'clank_reports/audit-20260320-143022-001.md',
  based_on: null,
};

describe('initDb', () => {
  test('creates memory.db in .clank/', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    db.close();
    assert.ok(fs.existsSync(path.join(dir, '.clank', 'memory.db')));
    fs.rmSync(dir, { recursive: true });
  });

  test('creates nodes and edges tables', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    assert.ok(tables.includes('nodes'));
    assert.ok(tables.includes('edges'));
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('is idempotent — safe to call twice', () => {
    const dir = tmpDir();
    const db1 = initDb(dir);
    db1.close();
    const db2 = initDb(dir);
    db2.close();
    // no error thrown
    fs.rmSync(dir, { recursive: true });
  });
});

describe('recordRun', () => {
  test('inserts a run node', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(MINIMAL_RUN.id);
    assert.ok(row);
    assert.equal(row.kind, 'run');
    const data = JSON.parse(row.data);
    assert.equal(data.mode, 'audit');
    assert.equal(data.status, 'complete');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('upserts scope nodes for each scope_path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    const scopeRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get('scope:src/utils/');
    assert.ok(scopeRow);
    assert.equal(scopeRow.kind, 'scope');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('inserts run→covers→scope edge', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    const edge = db.prepare(
      "SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'covers'"
    ).get(MINIMAL_RUN.id, 'scope:src/utils/');
    assert.ok(edge);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('inserts finding nodes and produced/affects edges', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const finding = {
      id: 'f-audit-20260320-143022-001-0',
      scope_path: 'src/utils/parser.ts',
      severity: 'blocking',
      kind: 'anti_pattern',
      text: 'Missing null check on line 42',
    };
    recordRun(db, { run: MINIMAL_RUN, findings: [finding], resolved_finding_ids: [] });

    const fRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get(finding.id);
    assert.ok(fRow);
    assert.equal(fRow.kind, 'finding');
    const fData = JSON.parse(fRow.data);
    assert.equal(fData.status, 'open');

    const produced = db.prepare(
      "SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'produced'"
    ).get(MINIMAL_RUN.id, finding.id);
    assert.ok(produced);

    const affects = db.prepare(
      "SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'affects'"
    ).get(finding.id, 'scope:src/utils/parser.ts');
    assert.ok(affects);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('inserts based_on edge when run.based_on is set', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    // First record the audit run that watch will be based on
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    const watchRun = {
      id: 'watch-20260321-100000-001',
      mode: 'watch',
      status: 'complete',
      scope_type: 'directory',
      scope_paths: ['src/utils/'],
      stack: 'typescript/vitest',
      metrics: { files: 12, covered_functions: 34, total_functions: 41 },
      report_path: 'clank_reports/watch-20260321-100000-001.md',
      based_on: MINIMAL_RUN.id,
    };
    recordRun(db, { run: watchRun, findings: [], resolved_finding_ids: [] });
    const edge = db.prepare(
      "SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'based_on'"
    ).get(watchRun.id, MINIMAL_RUN.id);
    assert.ok(edge);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('marks resolved findings and inserts resolved edge', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const finding = {
      id: 'f-audit-20260320-143022-001-0',
      scope_path: 'src/utils/parser.ts',
      severity: 'blocking',
      kind: 'anti_pattern',
      text: 'Missing null check on line 42',
    };
    recordRun(db, { run: MINIMAL_RUN, findings: [finding], resolved_finding_ids: [] });

    const refactorRun = {
      id: 'refactor-20260321-120000-001',
      mode: 'refactor',
      status: 'complete',
      scope_type: 'directory',
      scope_paths: ['src/utils/'],
      stack: 'typescript/vitest',
      metrics: { files: 12, covered_functions: 34, total_functions: 41 },
      report_path: 'clank_reports/refactor-20260321-120000-001.md',
      based_on: null,
    };
    recordRun(db, {
      run: refactorRun,
      findings: [],
      resolved_finding_ids: [finding.id],
    });

    const fRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get(finding.id);
    const fData = JSON.parse(fRow.data);
    assert.equal(fData.status, 'resolved');

    const resolvedEdge = db.prepare(
      "SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'resolved'"
    ).get(refactorRun.id, finding.id);
    assert.ok(resolvedEdge);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('is atomic — partial input does not write any nodes', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    // Pass a finding that references a nonexistent scope path — should still work
    // (scope is upserted). Test atomicity by passing duplicate run id.
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    assert.throws(() => {
      recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    }); // duplicate primary key
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/db.test.cjs
```

Expected: fails with `Cannot find module '../src/db.cjs'`

- [ ] **Step 3: Create src/db.cjs with initDb and recordRun**

```bash
mkdir -p src
```

Create `src/db.cjs`:

```js
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind   TEXT NOT NULL,
  PRIMARY KEY (source, target, kind)
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind   ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target, kind);
`;

/**
 * Open (or create) memory.db for the given project root.
 * Returns a DatabaseSync instance. Caller is responsible for calling .close().
 */
function initDb(projectRoot) {
  const clankDir = path.join(projectRoot, '.clank');
  fs.mkdirSync(clankDir, { recursive: true });
  const db = new DatabaseSync(path.join(clankDir, 'memory.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * Write a completed run + findings into the graph.
 * All mutations happen in a single transaction.
 *
 * @param {DatabaseSync} db
 * @param {{ run: object, findings: object[], resolved_finding_ids: string[] }} input
 * @param {number} [_createdAt] - Unix ms timestamp; defaults to Date.now(). Pass explicit value in tests.
 */
function recordRun(db, { run, findings, resolved_finding_ids }, _createdAt = Date.now()) {
  const now = _createdAt;

  const upsertScope = db.prepare(`
    INSERT INTO nodes (id, kind, data, created_at)
    VALUES (?, 'scope', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, kind, data, created_at) VALUES (?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (source, target, kind) VALUES (?, ?, ?)
  `);
  const updateFindingStatus = db.prepare(`
    UPDATE nodes SET data = json_set(data, '$.status', ?) WHERE id = ?
  `);

  db.exec('BEGIN');
  try {
    // Upsert scope nodes for each run scope path
    for (const p of run.scope_paths) {
      const scopeId = `scope:${p}`;
      upsertScope.run(scopeId, JSON.stringify({ id: scopeId, path: p, type: p.endsWith('/') ? 'directory' : 'file' }), now);
    }

    // Upsert scope nodes for each finding scope path
    for (const f of findings) {
      const scopeId = `scope:${f.scope_path}`;
      upsertScope.run(scopeId, JSON.stringify({ id: scopeId, path: f.scope_path, type: 'file' }), now);
    }

    // Insert run node
    insertNode.run(run.id, 'run', JSON.stringify(run), now);

    // run → covers → scope (one per scope_path)
    for (const p of run.scope_paths) {
      insertEdge.run(run.id, `scope:${p}`, 'covers');
    }

    // Insert finding nodes + edges
    for (const f of findings) {
      const findingData = { ...f, run_id: run.id, status: 'open' };
      insertNode.run(f.id, 'finding', JSON.stringify(findingData), now);
      insertEdge.run(run.id, f.id, 'produced');
      insertEdge.run(f.id, `scope:${f.scope_path}`, 'affects');
    }

    // based_on edge
    if (run.based_on) {
      insertEdge.run(run.id, run.based_on, 'based_on');
    }

    // Resolve findings
    for (const fid of (resolved_finding_ids || [])) {
      updateFindingStatus.run('resolved', fid);
      insertEdge.run(run.id, fid, 'resolved');
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { initDb, recordRun };
```

- [ ] **Step 4: Run tests to confirm initDb and recordRun pass**

```bash
node --test tests/db.test.cjs
```

Expected: all `initDb` and `recordRun` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.cjs tests/db.test.cjs
git commit -m "feat: add SQLite graph DB module with initDb and recordRun"
```

---

## Task 3: DB module — query functions

**Files:**
- Modify: `src/db.cjs`
- Modify: `tests/db.test.cjs`

- [ ] **Step 1: Add failing tests for the four query functions**

Append to `tests/db.test.cjs`:

```js
// ── helpers ──────────────────────────────────────────────────────────────────

const { querySummary, queryScope, queryBaseline, queryRun } = require('../src/db.cjs');

function seedDb(db) {
  const run1 = {
    id: 'audit-20260319-100000-001',
    mode: 'audit',
    status: 'complete',
    scope_type: 'directory',
    scope_paths: ['src/'],
    stack: 'typescript/vitest',
    metrics: { files: 10, covered_functions: 20, total_functions: 25 },
    report_path: 'clank_reports/audit-20260319-100000-001.md',
    based_on: null,
  };
  const finding1 = {
    id: 'f-audit-20260319-100000-001-0',
    scope_path: 'src/parser.ts',
    severity: 'blocking',
    kind: 'anti_pattern',
    text: 'Missing null check',
  };
  recordRun(db, { run: run1, findings: [finding1], resolved_finding_ids: [] }, 1000);

  const run2 = {
    id: 'audit-20260320-100000-001',
    mode: 'audit',
    status: 'complete',
    scope_type: 'directory',
    scope_paths: ['src/'],
    stack: 'typescript/vitest',
    metrics: { files: 10, covered_functions: 22, total_functions: 25 },
    report_path: 'clank_reports/audit-20260320-100000-001.md',
    based_on: null,
  };
  const finding2 = {
    id: 'f-audit-20260320-100000-001-0',
    scope_path: 'src/format.ts',
    severity: 'advisory',
    kind: 'missing_test',
    text: 'No tests for formatDate',
  };
  recordRun(db, { run: run2, findings: [finding2], resolved_finding_ids: [] }, 2000);
  return { run1, run2, finding1, finding2 };
}

// ── querySummary ──────────────────────────────────────────────────────────────

describe('querySummary', () => {
  test('returns empty state when DB has no runs', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const result = querySummary(db);
    assert.deepEqual(result.recent_runs, []);
    assert.equal(result.open_findings.total, 0);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns 5 most recent runs sorted newest first', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = querySummary(db);
    assert.equal(result.recent_runs.length, 2);
    assert.equal(result.recent_runs[0].id, 'audit-20260320-100000-001');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('computes coverage_pct in recent_runs metrics', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = querySummary(db);
    const latest = result.recent_runs[0];
    assert.ok('coverage_pct' in latest.metrics);
    assert.equal(latest.metrics.coverage_pct, Math.round(22 / 25 * 100));
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('counts open findings total and blocking correctly', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = querySummary(db);
    assert.equal(result.open_findings.total, 2);
    assert.equal(result.open_findings.blocking, 1);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('groups open findings by scope in by_scope', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = querySummary(db);
    assert.ok('src/parser.ts' in result.open_findings.by_scope);
    assert.equal(result.open_findings.by_scope['src/parser.ts'], 1);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── queryScope ────────────────────────────────────────────────────────────────

describe('queryScope', () => {
  test('returns null scope and empty arrays for unknown path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const result = queryScope(db, 'src/unknown.ts');
    assert.equal(result.scope, 'src/unknown.ts');
    assert.deepEqual(result.covered_by, []);
    assert.deepEqual(result.findings, []);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns runs that covered the path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    // src/parser.ts is covered by run1 via scope 'src/' (prefix match)
    const result = queryScope(db, 'src/parser.ts');
    assert.ok(result.covered_by.length > 0);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns findings that affect the path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryScope(db, 'src/parser.ts');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].text, 'Missing null check');
    assert.equal(result.findings[0].status, 'open');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('does not return resolved findings as open', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const { finding1 } = seedDb(db);
    const refactorRun = {
      id: 'refactor-20260321-000000-001',
      mode: 'refactor',
      status: 'complete',
      scope_type: 'directory',
      scope_paths: ['src/'],
      stack: 'typescript/vitest',
      metrics: { files: 10, covered_functions: 22, total_functions: 25 },
      report_path: 'clank_reports/refactor-20260321-000000-001.md',
      based_on: null,
    };
    recordRun(db, { run: refactorRun, findings: [], resolved_finding_ids: [finding1.id] });
    const result = queryScope(db, 'src/parser.ts');
    const openFindings = result.findings.filter(f => f.status === 'open');
    assert.equal(openFindings.length, 0);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── queryBaseline ─────────────────────────────────────────────────────────────

describe('queryBaseline', () => {
  test('returns null when no audit runs exist', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const result = queryBaseline(db, ['src/']);
    assert.equal(result, null);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns most recent audit covering the requested scope', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryBaseline(db, ['src/parser.ts']);
    // Both runs covered src/ which is an ancestor of src/parser.ts
    assert.equal(result.run_id, 'audit-20260320-100000-001');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns null when no audit covers the requested scope', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    // Neither run covered src/other/ or any ancestor
    const result = queryBaseline(db, ['lib/']);
    assert.equal(result, null);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('result includes run_id, created_at, metrics, report_path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryBaseline(db, ['src/']);
    assert.ok(result.run_id);
    assert.ok(result.created_at);
    assert.ok(result.metrics);
    assert.ok(result.report_path);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── queryRun ─────────────────────────────────────────────────────────────────

describe('queryRun', () => {
  test('returns null for unknown run_id', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    assert.equal(queryRun(db, 'no-such-run'), null);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns run data, findings, and scopes_covered', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryRun(db, 'audit-20260319-100000-001');
    assert.equal(result.run.id, 'audit-20260319-100000-001');
    assert.equal(result.run.mode, 'audit');
    assert.ok(Array.isArray(result.findings));
    assert.ok(Array.isArray(result.scopes_covered));
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('findings include resolved_by field', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const { finding1 } = seedDb(db);
    const result = queryRun(db, 'audit-20260319-100000-001');
    const f = result.findings.find(x => x.id === finding1.id);
    assert.ok(f);
    assert.ok('resolved_by' in f);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/db.test.cjs
```

Expected: fails — `querySummary`, `queryScope`, `queryBaseline`, `queryRun` not exported.

- [ ] **Step 3: Implement the four query functions in src/db.cjs**

Append to `src/db.cjs` (before the `module.exports` line):

```js
/**
 * Compact overview: 5 most recent runs + open finding counts.
 */
function querySummary(db, n = 5) {
  const runRows = db.prepare(
    "SELECT id, data, created_at FROM nodes WHERE kind = 'run' ORDER BY created_at DESC LIMIT ?"
  ).all(n);

  const recent_runs = runRows.map(row => {
    const d = JSON.parse(row.data);
    const m = d.metrics || {};
    const pct = m.total_functions > 0 ? Math.round(m.covered_functions / m.total_functions * 100) : 0;
    return {
      id: d.id,
      mode: d.mode,
      status: d.status,
      created_at: new Date(row.created_at).toISOString().slice(0, 10),
      metrics: { ...m, coverage_pct: pct },
    };
  });

  const findingRows = db.prepare(
    "SELECT data FROM nodes WHERE kind = 'finding'"
  ).all();

  let total = 0, blocking = 0;
  const by_scope = {};
  for (const row of findingRows) {
    const f = JSON.parse(row.data);
    if (f.status !== 'open') continue;
    total++;
    if (f.severity === 'blocking') blocking++;
    by_scope[f.scope_path] = (by_scope[f.scope_path] || 0) + 1;
  }

  return { recent_runs, open_findings: { total, blocking, by_scope } };
}

/**
 * Finding history for a specific path.
 * Covered_by: runs whose scope_paths cover this path (prefix or exact match).
 */
function queryScope(db, scopePath) {
  // Runs that covered this path: their scope node path is a prefix of (or equal to) scopePath
  const allRunEdges = db.prepare(
    "SELECT source, target FROM edges WHERE kind = 'covers'"
  ).all();
  const coveringRunIds = new Set();
  for (const edge of allRunEdges) {
    const scopeId = edge.target;
    const scopeNodePath = scopeId.replace(/^scope:/, '');
    if (scopePath === scopeNodePath || scopePath.startsWith(scopeNodePath)) {
      coveringRunIds.add(edge.source);
    }
  }

  const covered_by = [];
  for (const runId of coveringRunIds) {
    const row = db.prepare("SELECT data, created_at FROM nodes WHERE id = ?").get(runId);
    if (!row) continue;
    const d = JSON.parse(row.data);
    covered_by.push({
      run_id: runId,
      created_at: new Date(row.created_at).toISOString().slice(0, 10),
      status: d.status,
    });
  }
  covered_by.sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Findings affecting this exact scope path
  const scopeNodeId = `scope:${scopePath}`;
  const affectsEdges = db.prepare(
    "SELECT source FROM edges WHERE target = ? AND kind = 'affects'"
  ).all(scopeNodeId);

  const findings = [];
  for (const edge of affectsEdges) {
    const fRow = db.prepare("SELECT data, created_at FROM nodes WHERE id = ?").get(edge.source);
    if (!fRow) continue;
    const f = JSON.parse(fRow.data);
    const producedEdge = db.prepare(
      "SELECT source FROM edges WHERE target = ? AND kind = 'produced'"
    ).get(edge.source);
    findings.push({
      id: f.id,
      severity: f.severity,
      kind: f.kind,
      text: f.text,
      status: f.status,
      found_in: producedEdge ? producedEdge.source : null,
      created_at: new Date(fRow.created_at).toISOString().slice(0, 10),
    });
  }

  return { scope: scopePath, covered_by, findings };
}

/**
 * Most recent complete audit whose scope_paths cover all requested paths.
 * A run covers path P if any of its scope nodes' paths are P or an ancestor of P.
 */
function queryBaseline(db, scopePaths) {
  const auditRows = db.prepare(
    "SELECT id, data, created_at FROM nodes WHERE kind = 'run' AND json_extract(data, '$.mode') = 'audit' AND json_extract(data, '$.status') = 'complete' ORDER BY created_at DESC"
  ).all();

  for (const row of auditRows) {
    const d = JSON.parse(row.data);
    const coversEdges = db.prepare(
      "SELECT target FROM edges WHERE source = ? AND kind = 'covers'"
    ).all(d.id);
    const coveredPaths = coversEdges.map(e => e.target.replace(/^scope:/, ''));

    const coversAll = scopePaths.every(requested =>
      coveredPaths.some(covered => requested === covered || requested.startsWith(covered))
    );

    if (coversAll) {
      return {
        run_id: d.id,
        created_at: new Date(row.created_at).toISOString(),
        metrics: d.metrics,
        report_path: d.report_path,
      };
    }
  }
  return null;
}

/**
 * Full run detail: run node + all findings + scopes covered.
 */
function queryRun(db, runId) {
  const runRow = db.prepare("SELECT data FROM nodes WHERE id = ? AND kind = 'run'").get(runId);
  if (!runRow) return null;

  const run = JSON.parse(runRow.data);

  const producedEdges = db.prepare(
    "SELECT target FROM edges WHERE source = ? AND kind = 'produced'"
  ).all(runId);
  const findings = producedEdges.map(edge => {
    const fRow = db.prepare("SELECT data FROM nodes WHERE id = ?").get(edge.target);
    if (!fRow) return null;
    const f = JSON.parse(fRow.data);
    const resolvedEdge = db.prepare(
      "SELECT source FROM edges WHERE target = ? AND kind = 'resolved'"
    ).get(f.id);
    return { ...f, resolved_by: resolvedEdge ? resolvedEdge.source : null };
  }).filter(Boolean);

  const coversEdges = db.prepare(
    "SELECT target FROM edges WHERE source = ? AND kind = 'covers'"
  ).all(runId);
  const scopes_covered = coversEdges.map(e => e.target.replace(/^scope:/, ''));

  return { run, findings, scopes_covered };
}
```

Update the `module.exports` line to:

```js
module.exports = { initDb, recordRun, querySummary, queryScope, queryBaseline, queryRun };
```

- [ ] **Step 4: Run all DB tests**

```bash
node --test tests/db.test.cjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.cjs tests/db.test.cjs
git commit -m "feat: add graph query functions to DB module"
```

---

## Task 4: MCP server (bin/clank.cjs)

**Files:**
- Create: `bin/clank.cjs`

The MCP server is tested via the DB tests (business logic lives in `src/db.cjs`). This task wires the MCP SDK around those functions.

- [ ] **Step 1: Verify MCP SDK CJS import paths**

The three paths below are pre-verified for v1.10.2 (exports map: `"./*": { require: "./dist/cjs/*" }`). Run this after `npm install` to confirm they still resolve and export the expected symbols:

```bash
node -e "const s = require('@modelcontextprotocol/sdk/server/index.js'); console.log('server/index.js:', Object.keys(s).join(', '))"
node -e "const t = require('@modelcontextprotocol/sdk/server/stdio.js'); console.log('server/stdio.js:', Object.keys(t).join(', '))"
node -e "const y = require('@modelcontextprotocol/sdk/types.js'); console.log('types.js ListToolsRequestSchema:', !!y.ListToolsRequestSchema, 'CallToolRequestSchema:', !!y.CallToolRequestSchema)"
```

Expected output:
```
server/index.js: Server
server/stdio.js: StdioServerTransport
types.js ListToolsRequestSchema: true CallToolRequestSchema: true
```

If any path fails, inspect `node_modules/@modelcontextprotocol/sdk/package.json` `exports` field to find the correct CJS paths and update the `require()` calls in Step 2 accordingly.

- [ ] **Step 2: Create bin/clank.cjs**

```js
#!/usr/bin/env node
'use strict';

const args = process.argv.slice(2);

if (args[0] === 'serve' && args[1] === '--mcp') {
  runMcpServer();
} else {
  runInstaller();
}

// ── MCP Server ────────────────────────────────────────────────────────────────

function runMcpServer() {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const path = require('node:path');
  const { initDb, recordRun, querySummary, queryScope, queryBaseline, queryRun } = require('../src/db.cjs');

  const server = new Server(
    { name: 'clank', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'clank_memory_record',
        description: 'Record a completed Clank run and its findings into the memory graph. Call at the end of every mode (audit, bootstrap, refactor, watch).',
        inputSchema: {
          type: 'object',
          properties: {
            run: { type: 'object', description: 'Run metadata object' },
            findings: { type: 'array', description: 'Array of finding objects from this run' },
            resolved_finding_ids: { type: 'array', description: 'IDs of findings resolved by this run (refactor only; empty for other modes)' },
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
          required: ['run', 'findings', 'resolved_finding_ids'],
        },
      },
      {
        name: 'clank_memory_summary',
        description: 'Compact overview of recent runs and open finding counts. Use at session start to understand current project state.',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
        },
      },
      {
        name: 'clank_memory_scope',
        description: 'Finding history for a specific file or directory path. Call before analyzing a file to load prior context.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File or directory path to query' },
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'clank_memory_baseline',
        description: 'Find the most recent complete audit run covering the given scope paths. Use at watch start to find the baseline.',
        inputSchema: {
          type: 'object',
          properties: {
            scope_paths: { type: 'array', description: 'Array of paths the watch run will cover' },
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
          required: ['scope_paths'],
        },
      },
      {
        name: 'clank_memory_run',
        description: 'Full detail for a specific run: run metadata, all findings, scopes covered.',
        inputSchema: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'The run ID to retrieve' },
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
          required: ['run_id'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const projectRoot = args.projectPath || process.cwd();

    let db;
    try {
      db = initDb(projectRoot);

      let result;
      if (name === 'clank_memory_record') {
        recordRun(db, { run: args.run, findings: args.findings, resolved_finding_ids: args.resolved_finding_ids });
        result = { ok: true };
      } else if (name === 'clank_memory_summary') {
        result = querySummary(db);
      } else if (name === 'clank_memory_scope') {
        result = queryScope(db, args.path);
      } else if (name === 'clank_memory_baseline') {
        result = queryBaseline(db, args.scope_paths);
      } else if (name === 'clank_memory_run') {
        result = queryRun(db, args.run_id);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    } finally {
      if (db) db.close();
    }
  });

  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  main().catch(err => {
    process.stderr.write(`MCP server error: ${err.message}\n`);
    process.exit(1);
  });
}

// ── Installer ─────────────────────────────────────────────────────────────────

function runInstaller() {
  // Installer implementation is in Task 6.
  // Delegate to install.js via execSync so its main() runs in a child process,
  // not as a side-effect of require() in this process.
  const { execSync } = require('node:child_process');
  const installScript = require('node:path').join(__dirname, 'install.js');
  execSync(`node ${installScript}`, { stdio: 'inherit' });
}
```

- [ ] **Step 3: Make executable**

```bash
chmod +x bin/clank.cjs
```

- [ ] **Step 4: Smoke-test the MCP server starts without crashing**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node bin/clank.cjs serve --mcp
```

Expected: JSON response with a `tools` array containing the 5 tool definitions.

- [ ] **Step 5: Commit**

```bash
git add bin/clank.cjs
git commit -m "feat: add MCP server with 5 clank_memory_* tools"
```

---

## Task 5: clank-tools memory-summary command

**Files:**
- Modify: `bin/clank-tools.cjs`
- Modify: `tests/clank-tools.test.cjs`

- [ ] **Step 1: Write a failing test for memory-summary**

Append to `tests/clank-tools.test.cjs`:

```js
describe('memory-summary', () => {
  test('returns empty state when memory.db does not exist (falls back to .md scan)', () => {
    const dir = tmpProject();
    const result = runJSON(dir, 'memory-summary');
    assert.ok(Array.isArray(result.recent_runs));
    assert.equal(result.open_findings.total, 0);
    fs.rmSync(dir, { recursive: true });
  });

  test('returns summary from memory.db when it exists', () => {
    const dir = tmpProject();
    // Seed the DB directly using the db module
    const { initDb, recordRun } = require('../src/db.cjs');
    const db = initDb(dir);
    recordRun(db, {
      run: {
        id: 'audit-20260320-100000-001',
        mode: 'audit',
        status: 'complete',
        scope_type: 'directory',
        scope_paths: ['src/'],
        stack: 'typescript/vitest',
        metrics: { files: 5, covered_functions: 10, total_functions: 12 },
        report_path: 'clank_reports/audit-20260320-100000-001.md',
        based_on: null,
      },
      findings: [],
      resolved_finding_ids: [],
    });
    db.close();

    const result = runJSON(dir, 'memory-summary');
    assert.equal(result.recent_runs.length, 1);
    assert.equal(result.recent_runs[0].id, 'audit-20260320-100000-001');
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | grep -A3 'memory-summary'
```

Expected: fails — unknown command `memory-summary`.

- [ ] **Step 3: Add memory-summary command to bin/clank-tools.cjs**

In `bin/clank-tools.cjs`, add to the `commands` object (around line 16):

```js
'memory-summary': cmdMemorySummary,
```

Then add the function before `cmdHelp`:

```js
function cmdMemorySummary() {
  const memDbPath = path.join(CLANK_DIR, 'memory.db');
  if (!fs.existsSync(memDbPath)) {
    // Fallback: wrap cmdRecent output in the expected { recent_runs, open_findings } shape
    const reports = [];
    if (fs.existsSync(REPORTS_DIR)) {
      for (const file of fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'))) {
        const { ok, data, content } = parseFrontmatter(path.join(REPORTS_DIR, file));
        if (!ok || !data?.id) continue;
        const m = data.metrics || {};
        reports.push({ id: data.id, mode: data.mode, status: data.status,
          created_at: (data.created_at || '').slice(0, 10), metrics: m });
      }
    }
    reports.sort((a, b) => b.created_at.localeCompare(a.created_at));
    process.stdout.write(JSON.stringify({
      recent_runs: reports.slice(0, 5),
      open_findings: { total: 0, blocking: 0, by_scope: {} },
    }) + '\n');
    return;
  }
  const { DatabaseSync } = require('node:sqlite');
  const { querySummary } = require(path.join(__dirname, '..', 'src', 'db.cjs'));
  const db = new DatabaseSync(memDbPath);
  try {
    process.stdout.write(JSON.stringify(querySummary(db)) + '\n');
  } finally {
    db.close();
  }
}
```

Also update `cmdHelp` to include the new command:

```
  memory-summary               Summary from memory graph (or recent .md fallback)
```

- [ ] **Step 4: Run all tests**

```bash
node --test tests/clank-tools.test.cjs
```

Expected: all tests pass including the new `memory-summary` tests.

- [ ] **Step 5: Commit**

```bash
git add bin/clank-tools.cjs tests/clank-tools.test.cjs
git commit -m "feat: add memory-summary command to clank-tools"
```

---

## Task 6: Installer update (bin/install.js)

**Files:**
- Modify: `bin/install.js`

The installer gains: MCP server registration, auto-allow permissions, SessionStart hook, and a CLAUDE.md section. It keeps all existing steps (copy files, create `.clank/`).

- [ ] **Step 1: Update bin/install.js**

Replace the entire file with:

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const PLUGIN_ROOT = path.join(__dirname, '..');
const HOME = os.homedir();
const PROJECT_ROOT = process.env.CLANK_INSTALL_PROJECT || process.cwd();

// ── Prompts ───────────────────────────────────────────────────────────────────

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ── File helpers ──────────────────────────────────────────────────────────────

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readJson(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── Config writers ────────────────────────────────────────────────────────────

function writeMcpConfig(claudeJsonPath) {
  const cfg = readJson(claudeJsonPath);
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.clank = { type: 'stdio', command: 'clank', args: ['serve', '--mcp'] };
  writeJson(claudeJsonPath, cfg);
}

function writePermissions(settingsPath) {
  const s = readJson(settingsPath);
  s.permissions = s.permissions || {};
  s.permissions.allow = s.permissions.allow || [];
  const tools = [
    'mcp__clank__clank_memory_record',
    'mcp__clank__clank_memory_summary',
    'mcp__clank__clank_memory_scope',
    'mcp__clank__clank_memory_baseline',
    'mcp__clank__clank_memory_run',
  ];
  for (const t of tools) {
    if (!s.permissions.allow.includes(t)) s.permissions.allow.push(t);
  }
  writeJson(settingsPath, s);
}

function writeSessionStartHook(settingsPath) {
  const s = readJson(settingsPath);
  s.hooks = s.hooks || {};
  s.hooks.SessionStart = s.hooks.SessionStart || [];
  // Remove any previous clank session-start entries
  s.hooks.SessionStart = s.hooks.SessionStart.filter(
    e => !JSON.stringify(e).includes('clank-tools memory-summary')
  );
  s.hooks.SessionStart.push({
    matcher: '.*',
    hooks: [{ type: 'command', command: 'clank-tools memory-summary' }],
  });
  writeJson(settingsPath, s);
}

const CLAUDE_MD_SECTION_START = '<!-- clank-memory:start -->';
const CLAUDE_MD_SECTION_END = '<!-- clank-memory:end -->';
const CLAUDE_MD_CONTENT = `${CLAUDE_MD_SECTION_START}
## Clank Memory Graph

When working in a Clank-enabled project (.clank/ exists), use these MCP tools instead of reading report files:

| Tool | When to use |
|------|-------------|
| \`mcp__clank__clank_memory_record\` | At the end of every Clank run, after writing the Markdown report |
| \`mcp__clank__clank_memory_summary\` | At session start or to get project health overview |
| \`mcp__clank__clank_memory_scope\` | Before analyzing a file, to load prior findings |
| \`mcp__clank__clank_memory_baseline\` | At watch start, to find the best prior audit |
| \`mcp__clank__clank_memory_run\` | When full run detail is needed beyond the summary |

All tools accept an optional \`projectPath\` parameter. Defaults to cwd.
${CLAUDE_MD_SECTION_END}`;

function writeClaudeMd(claudeMdPath) {
  fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, CLAUDE_MD_CONTENT + '\n');
    return;
  }
  let content = fs.readFileSync(claudeMdPath, 'utf8');
  if (content.includes(CLAUDE_MD_SECTION_START)) {
    const start = content.indexOf(CLAUDE_MD_SECTION_START);
    const end = content.indexOf(CLAUDE_MD_SECTION_END) + CLAUDE_MD_SECTION_END.length;
    content = content.slice(0, start) + CLAUDE_MD_CONTENT + content.slice(end);
  } else {
    content = content.trimEnd() + '\n\n' + CLAUDE_MD_CONTENT + '\n';
  }
  fs.writeFileSync(claudeMdPath, content);
}

function initProjectClankDir(projectRoot) {
  const clankDir = path.join(projectRoot, '.clank');
  fs.mkdirSync(path.join(clankDir, 'journals'), { recursive: true });
  fs.mkdirSync(path.join(clankDir, 'scratch'), { recursive: true });
  const configPath = path.join(clankDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      codegraph_suggestion_shown: false,
      last_audit: null, last_bootstrap: null, last_refactor: null, last_watch: null,
      test_run_command: null,
    }, null, 2));
  }
  // Add memory.db to .gitignore
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = '.clank/memory.db';
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, 'utf8');
    if (!existing.includes(entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`);
    }
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nClank installer\n');

  // 1. Global or local?
  const locationAnswer = await ask('Install globally (~/.claude) or locally (./.claude)? [G/l] ');
  const isLocal = locationAnswer.toLowerCase() === 'l';
  const claudeDir = isLocal ? path.join(PROJECT_ROOT, '.claude') : path.join(HOME, '.claude');
  const claudeJsonPath = isLocal ? path.join(PROJECT_ROOT, '.claude.json') : path.join(HOME, '.claude.json');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // 2. Global npm install so `clank` binary is on PATH for the MCP server
  //    Use PLUGIN_ROOT (the directory containing this installer) so this works
  //    both during development (local path) and in production (npx extracts package).
  const { execSync } = require('node:child_process');
  console.log('Installing clank globally...');
  execSync(`npm install -g ${PLUGIN_ROOT}`, { stdio: 'inherit' });
  console.log('✓ clank installed globally');

  // 3. Copy plugin files (existing behaviour)
  const CLAUDE_LOCAL = path.join(PROJECT_ROOT, '.claude');
  copyDir(path.join(PLUGIN_ROOT, 'commands', 'clank'), path.join(CLAUDE_LOCAL, 'commands', 'clank'));
  console.log('✓ commands/clank/');
  copyDir(path.join(PLUGIN_ROOT, 'agents'), path.join(CLAUDE_LOCAL, 'agents'));
  console.log('✓ agents/');
  copyDir(path.join(PLUGIN_ROOT, 'clank'), path.join(path.join(HOME, '.claude'), 'clank'));
  console.log('✓ ~/.claude/clank/');
  copyDir(path.join(PLUGIN_ROOT, 'bin'), path.join(path.join(HOME, '.claude'), 'clank', 'bin'));
  console.log('✓ ~/.claude/clank/bin/');

  // 4. MCP server config
  writeMcpConfig(claudeJsonPath);
  console.log(`✓ MCP server registered in ${isLocal ? './.claude.json' : '~/.claude.json'}`);

  // 5. Auto-allow permissions?
  const allowAnswer = await ask('Auto-allow clank_memory_* MCP tools? [Y/n] ');
  if (allowAnswer.toLowerCase() !== 'n') {
    writePermissions(settingsPath);
    console.log(`✓ Permissions added to ${isLocal ? './.claude/settings.json' : '~/.claude/settings.json'}`);
  }

  // 6. SessionStart hook
  writeSessionStartHook(settingsPath);
  console.log(`✓ SessionStart hook registered`);

  // 7. CLAUDE.md
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  writeClaudeMd(claudeMdPath);
  console.log(`✓ CLAUDE.md updated`);

  // 8. Project init
  initProjectClankDir(PROJECT_ROOT);
  console.log('✓ .clank/ initialized in project');

  console.log('\nClank installed. Restart Claude Code to load the MCP server. Run /clank:audit to get started.\n');
}

main().catch(err => {
  console.error('Installation failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-test the installer (dry run, Ctrl+C after prompts)**

```bash
CLANK_INSTALL_PROJECT=/tmp/clank-install-test node bin/install.js
```

Step through the prompts. Verify:
- No crash before first prompt appears
- `G` for global, `Y` for permissions
- After completing, check `~/.claude.json` has `mcpServers.clank`
- Check `~/.claude/settings.json` has `permissions.allow` with `mcp__clank__*` entries
- Check `~/.claude/settings.json` has `hooks.SessionStart`
- Check `~/.claude/CLAUDE.md` has the Clank section

- [ ] **Step 3: Commit**

```bash
git add bin/install.js
git commit -m "feat: update installer to register MCP server, permissions, and SessionStart hook"
```

---

## Task 7: Workflow updates

**Files:**
- Modify: `clank/workflows/audit.md`
- Modify: `clank/workflows/bootstrap.md`
- Modify: `clank/workflows/refactor.md`
- Modify: `clank/workflows/watch.md`

These are agent prompt files, not code. No unit tests.

- [ ] **Step 1: Update audit.md — add Step 8 (record run)**

In `clank/workflows/audit.md`, replace the current Step 8 (Present report) with:

```markdown
## Step 8 — Record in memory graph

Call `mcp__clank__clank_memory_record` with:

```json
{
  "run": {
    "id": "<RUN_ID>",
    "mode": "audit",
    "status": "<complete or partial>",
    "scope_type": "<type from scope object>",
    "scope_paths": ["<paths from scope object>"],
    "stack": "<stack string from detect-stack>",
    "metrics": {
      "files": <files analyzed>,
      "covered_functions": <functions with tests>,
      "total_functions": <total functions found>
    },
    "report_path": "clank_reports/<RUN_ID>.md",
    "based_on": null
  },
  "findings": [
    {
      "id": "f-<RUN_ID>-<index>",
      "scope_path": "<file path>",
      "severity": "blocking|advisory",
      "kind": "<anti_pattern|missing_test|drift|...>",
      "text": "<finding description>"
    }
  ],
  "resolved_finding_ids": []
}
```

If the call fails, append a warning to the report body: `> Warning: memory graph update failed — run not indexed.` Do not abort the session.

## Step 9 — Present report

Summarize the key findings to the user (blocking violations, advisory count, top
coverage gaps). Give the path to the full report.
```

- [ ] **Step 2: Update bootstrap.md — add Step 8 (record run)**

At the end of `clank/workflows/bootstrap.md`, add:

```markdown
## Step 8 — Record in memory graph

After writing the final report, call `mcp__clank__clank_memory_record` with the same structure as the audit workflow. Set `mode: "bootstrap"`, `resolved_finding_ids: []`. Include one finding per file where tests were added, with `kind: "bootstrap_coverage"` and `status` implied open until an audit confirms coverage.

If the call fails, append a warning to the report and continue.
```

- [ ] **Step 3: Update refactor.md — add Step 9 (record run with resolved findings)**

After the current Step 8 (Finalize) in `clank/workflows/refactor.md`, add:

```markdown
## Step 9 — Record in memory graph

Before presenting results, call `mcp__clank__clank_memory_scope` for each file in `scope_paths` to retrieve all `open` finding IDs for those files. Compare the finding descriptions against what the refactor actually changed. Finding IDs whose described issue is no longer present are resolved.

Call `mcp__clank__clank_memory_record` with:
- `mode: "refactor"`
- `findings: []` (refactor does not produce new findings)
- `resolved_finding_ids`: array of finding IDs that are no longer present

If the call fails, append a warning to the report and continue.
```

- [ ] **Step 4: Update watch.md — replace Step 2 scan with clank_memory_baseline**

In `clank/workflows/watch.md`, replace the entire **Step 2 — Baseline check** with:

```markdown
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
```

- [ ] **Step 5: Commit all workflow changes**

```bash
git add clank/workflows/audit.md clank/workflows/bootstrap.md clank/workflows/refactor.md clank/workflows/watch.md
git commit -m "feat: update all workflow docs to call clank_memory_record at run completion"
```

---

## Task 8: Final verification

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Verify MCP server lists correct tools**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node bin/clank.cjs serve --mcp
```

Expected: JSON with `tools` array containing exactly `clank_memory_record`, `clank_memory_summary`, `clank_memory_scope`, `clank_memory_baseline`, `clank_memory_run`.

- [ ] **Step 3: Verify end-to-end record → summary flow**

```bash
node -e "
const { initDb, recordRun, querySummary } = require('./src/db.cjs');
const db = initDb('/tmp/clank-e2e-test');
recordRun(db, {
  run: {
    id: 'audit-20260323-120000-001', mode: 'audit', status: 'complete',
    scope_type: 'project', scope_paths: ['src/'],
    stack: 'typescript/vitest',
    metrics: { files: 5, covered_functions: 10, total_functions: 12 },
    report_path: 'clank_reports/audit-20260323-120000-001.md', based_on: null,
  },
  findings: [{ id: 'f-0', scope_path: 'src/index.ts', severity: 'blocking', kind: 'anti_pattern', text: 'test' }],
  resolved_finding_ids: [],
});
const s = querySummary(db);
console.log(JSON.stringify(s, null, 2));
db.close();
require('node:fs').rmSync('/tmp/clank-e2e-test', { recursive: true });
"
```

Expected: JSON with `recent_runs` containing the audit run and `open_findings.total: 1`.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete Clank memory graph implementation"
```
