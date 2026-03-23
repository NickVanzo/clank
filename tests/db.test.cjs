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
