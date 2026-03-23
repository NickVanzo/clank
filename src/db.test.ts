import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initDb, recordRun, querySummary, queryScope, queryBaseline, queryRun } from './db.js';

function tmpDir(): string {
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
    expect(fs.existsSync(path.join(dir, '.clank', 'memory.db'))).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  test('creates nodes and edges tables', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>).map(r => r.name);
    expect(tables).toContain('nodes');
    expect(tables).toContain('edges');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('is idempotent — safe to call twice', () => {
    const dir = tmpDir();
    const db1 = initDb(dir);
    db1.close();
    const db2 = initDb(dir);
    db2.close();
    fs.rmSync(dir, { recursive: true });
  });
});

describe('recordRun', () => {
  test('inserts a run node', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(MINIMAL_RUN.id) as { kind: string; data: string } | undefined;
    expect(row).toBeTruthy();
    expect(row?.kind).toBe('run');
    const data = JSON.parse(row?.data ?? '{}') as { mode: string; status: string };
    expect(data.mode).toBe('audit');
    expect(data.status).toBe('complete');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('upserts scope nodes for each scope_path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    const scopeRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get('scope:src/utils/') as { kind: string } | undefined;
    expect(scopeRow).toBeTruthy();
    expect(scopeRow?.kind).toBe('scope');
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
    expect(edge).toBeTruthy();
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

    const fRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get(finding.id) as { kind: string; data: string } | undefined;
    expect(fRow).toBeTruthy();
    expect(fRow?.kind).toBe('finding');
    expect((JSON.parse(fRow?.data ?? '{}') as { status: string }).status).toBe('open');

    expect(db.prepare("SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'produced'")
      .get(MINIMAL_RUN.id, finding.id)).toBeTruthy();
    expect(db.prepare("SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'affects'")
      .get(finding.id, 'scope:src/utils/parser.ts')).toBeTruthy();

    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('inserts based_on edge when run.based_on is set', () => {
    const dir = tmpDir();
    const db = initDb(dir);
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
    expect(db.prepare("SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'based_on'")
      .get(watchRun.id, MINIMAL_RUN.id)).toBeTruthy();
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
    recordRun(db, { run: refactorRun, findings: [], resolved_finding_ids: [finding.id] });

    const fRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get(finding.id) as { data: string } | undefined;
    expect((JSON.parse(fRow?.data ?? '{}') as { status: string }).status).toBe('resolved');
    expect(db.prepare("SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'resolved'")
      .get(refactorRun.id, finding.id)).toBeTruthy();

    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('is atomic — failed transaction does not write any nodes', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    recordRun(db, { run: MINIMAL_RUN, findings: [], resolved_finding_ids: [] });
    const runWithNewScope = { ...MINIMAL_RUN, scope_paths: ['src/new-path/'] };
    expect(() => {
      recordRun(db, { run: runWithNewScope, findings: [], resolved_finding_ids: [] });
    }).toThrow();
    expect(db.prepare("SELECT * FROM nodes WHERE id = ?").get('scope:src/new-path/')).toBeUndefined();
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function seedDb(db: ReturnType<typeof initDb>) {
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

describe('querySummary', () => {
  test('returns empty state when DB has no runs', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const result = querySummary(db);
    expect(result.recent_runs).toEqual([]);
    expect(result.open_findings.total).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns 5 most recent runs sorted newest first', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = querySummary(db);
    expect(result.recent_runs).toHaveLength(2);
    expect(result.recent_runs[0]?.id).toBe('audit-20260320-100000-001');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('computes coverage_pct in recent_runs metrics', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = querySummary(db);
    const latest = result.recent_runs[0];
    expect(latest?.metrics).toHaveProperty('coverage_pct');
    expect(latest?.metrics['coverage_pct']).toBe(Math.round(22 / 25 * 100));
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('counts open findings total and blocking correctly', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = querySummary(db);
    expect(result.open_findings.total).toBe(2);
    expect(result.open_findings.blocking).toBe(1);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('groups open findings by scope in by_scope', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = querySummary(db);
    expect('src/parser.ts' in result.open_findings.by_scope).toBe(true);
    expect(result.open_findings.by_scope['src/parser.ts']).toBe(1);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});

describe('queryScope', () => {
  test('returns null scope and empty arrays for unknown path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const result = queryScope(db, 'src/unknown.ts');
    expect(result.scope).toBe('src/unknown.ts');
    expect(result.covered_by).toEqual([]);
    expect(result.findings).toEqual([]);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns runs that covered the path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryScope(db, 'src/parser.ts');
    expect(result.covered_by.length).toBeGreaterThan(0);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns findings that affect the path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryScope(db, 'src/parser.ts');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.text).toBe('Missing null check');
    expect(result.findings[0]?.status).toBe('open');
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
    expect(result.findings.filter(f => f.status === 'open')).toHaveLength(0);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});

describe('queryBaseline', () => {
  test('returns null when no audit runs exist', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    expect(queryBaseline(db, ['src/'])).toBeNull();
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns most recent audit covering the requested scope', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryBaseline(db, ['src/parser.ts']);
    expect(result?.run_id).toBe('audit-20260320-100000-001');
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns null when no audit covers the requested scope', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    expect(queryBaseline(db, ['lib/'])).toBeNull();
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('result includes run_id, created_at, metrics, report_path', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryBaseline(db, ['src/']);
    expect(result?.run_id).toBeTruthy();
    expect(result?.created_at).toBeTruthy();
    expect(result?.metrics).toBeTruthy();
    expect(result?.report_path).toBeTruthy();
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});

describe('queryRun', () => {
  test('returns null for unknown run_id', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    expect(queryRun(db, 'no-such-run')).toBeNull();
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns run data, findings, and scopes_covered', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    seedDb(db);
    const result = queryRun(db, 'audit-20260319-100000-001');
    expect(result?.run.id).toBe('audit-20260319-100000-001');
    expect(result?.run.mode).toBe('audit');
    expect(Array.isArray(result?.findings)).toBe(true);
    expect(Array.isArray(result?.scopes_covered)).toBe(true);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  test('findings include resolved_by field', () => {
    const dir = tmpDir();
    const db = initDb(dir);
    const { finding1 } = seedDb(db);
    const result = queryRun(db, 'audit-20260319-100000-001');
    const f = result?.findings.find(x => x.id === finding1.id);
    expect(f).toBeTruthy();
    expect('resolved_by' in (f ?? {})).toBe(true);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});
