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

  test('is atomic — failed transaction does not write any nodes', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    // Second call with same run.id (duplicate PK) but a new scope_path.
    // If rollback works, scope:src/new-path/ must NOT be present after the throw.
    const runWithNewScope = { ...MINIMAL_RUN, scope_paths: ['src/new-path/'] };
    assert.throws(() => {
      recordRun(db, { run: runWithNewScope, findings: [], resolved_finding_ids: [] });
    });
    const rolledBackScope = db.prepare("SELECT * FROM nodes WHERE id = ?").get('scope:src/new-path/');
    assert.equal(rolledBackScope, undefined, 'scope node from failed transaction should be rolled back');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});

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
