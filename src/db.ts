import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';

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

export interface Run {
  id: string;
  mode: string;
  status: string;
  scope_type: string;
  scope_paths: string[];
  stack: string;
  metrics: Record<string, number>;
  report_path: string;
  based_on: string | null;
}

export interface Finding {
  id: string;
  scope_path: string;
  severity: string;
  kind: string;
  text: string;
}

interface NodeRow { id: string; kind: string; data: string; created_at: number }
interface EdgeRow { source: string; target: string; kind: string }

export function initDb(projectRoot: string): DatabaseSync {
  const clankDir = path.join(projectRoot, '.clank');
  fs.mkdirSync(clankDir, { recursive: true });
  const db = new DatabaseSync(path.join(clankDir, 'memory.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function recordRun(
  db: DatabaseSync,
  { run, findings, resolved_finding_ids }: {
    run: Run;
    findings: Finding[];
    resolved_finding_ids: string[];
  },
  _createdAt: number = Date.now()
): void {
  const now = _createdAt;

  const upsertScope = db.prepare(`
    INSERT INTO nodes (id, kind, data, created_at)
    VALUES (?, 'scope', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, kind, data, created_at) VALUES (?, ?, ?, ?)`
  );
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (source, target, kind) VALUES (?, ?, ?)`
  );
  const updateFindingStatus = db.prepare(
    `UPDATE nodes SET data = json_set(data, '$.status', ?) WHERE id = ?`
  );

  db.exec('BEGIN');
  try {
    for (const p of run.scope_paths) {
      const scopeId = `scope:${p}`;
      const isDir = p.endsWith('/');
      upsertScope.run(scopeId, JSON.stringify({ id: scopeId, path: p, type: isDir ? 'directory' : 'file' }), now);
    }
    for (const f of findings) {
      const scopeId = `scope:${f.scope_path}`;
      upsertScope.run(scopeId, JSON.stringify({ id: scopeId, path: f.scope_path, type: 'file' }), now);
    }

    insertNode.run(run.id, 'run', JSON.stringify(run), now);

    for (const p of run.scope_paths) {
      insertEdge.run(run.id, `scope:${p}`, 'covers');
    }
    for (const f of findings) {
      const findingData = { ...f, run_id: run.id, status: 'open' };
      insertNode.run(f.id, 'finding', JSON.stringify(findingData), now);
      insertEdge.run(run.id, f.id, 'produced');
      insertEdge.run(f.id, `scope:${f.scope_path}`, 'affects');
    }

    if (run.based_on) {
      insertEdge.run(run.id, run.based_on, 'based_on');
    }
    for (const fid of (resolved_finding_ids ?? [])) {
      updateFindingStatus.run('resolved', fid);
      insertEdge.run(run.id, fid, 'resolved');
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface SummaryResult {
  recent_runs: Array<{
    id: string; mode: string; status: string; created_at: string;
    metrics: Record<string, number> & { coverage_pct: number };
  }>;
  open_findings: { total: number; blocking: number; by_scope: Record<string, number> };
}

export function querySummary(db: DatabaseSync, n = 5): SummaryResult {
  const runRows = db.prepare(
    "SELECT id, data, created_at FROM nodes WHERE kind = 'run' ORDER BY created_at DESC LIMIT ?"
  ).all(n) as unknown as NodeRow[];

  const recent_runs = runRows.map(row => {
    const d = JSON.parse(row.data) as Run & { metrics: Record<string, number> };
    const m = d.metrics ?? {};
    const total = m['total_functions'] ?? 0;
    const covered = m['covered_functions'] ?? 0;
    const pct = total > 0 ? Math.round(covered / total * 100) : 0;
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
  ).all() as Array<{ data: string }>;

  let total = 0, blocking = 0;
  const by_scope: Record<string, number> = {};
  for (const row of findingRows) {
    const f = JSON.parse(row.data) as Finding & { status: string };
    if (f.status !== 'open') continue;
    total++;
    if (f.severity === 'blocking') blocking++;
    by_scope[f.scope_path] = (by_scope[f.scope_path] ?? 0) + 1;
  }

  return { recent_runs, open_findings: { total, blocking, by_scope } };
}

export interface ScopeResult {
  scope: string;
  covered_by: Array<{ run_id: string; created_at: string; status: string }>;
  findings: Array<{
    id: string; severity: string; kind: string; text: string;
    status: string; found_in: string | null; created_at: string;
  }>;
}

export function queryScope(db: DatabaseSync, scopePath: string): ScopeResult {
  const allRunEdges = db.prepare(
    "SELECT source, target FROM edges WHERE kind = 'covers'"
  ).all() as unknown as EdgeRow[];

  const coveringRunIds = new Set<string>();
  for (const edge of allRunEdges) {
    const scopeNodePath = edge.target.replace(/^scope:/, '');
    if (scopePath === scopeNodePath || scopePath.startsWith(scopeNodePath)) {
      coveringRunIds.add(edge.source);
    }
  }

  const covered_by: ScopeResult['covered_by'] = [];
  for (const runId of coveringRunIds) {
    const row = db.prepare(
      "SELECT data, created_at FROM nodes WHERE id = ?"
    ).get(runId) as NodeRow | undefined;
    if (!row) continue;
    const d = JSON.parse(row.data) as { status: string };
    covered_by.push({
      run_id: runId,
      created_at: new Date(row.created_at).toISOString().slice(0, 10),
      status: d.status,
    });
  }
  covered_by.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const scopeNodeId = `scope:${scopePath}`;
  const affectsEdges = db.prepare(
    "SELECT source FROM edges WHERE target = ? AND kind = 'affects'"
  ).all(scopeNodeId) as Array<{ source: string }>;

  const findings: ScopeResult['findings'] = [];
  for (const edge of affectsEdges) {
    const fRow = db.prepare(
      "SELECT data, created_at FROM nodes WHERE id = ?"
    ).get(edge.source) as NodeRow | undefined;
    if (!fRow) continue;
    const f = JSON.parse(fRow.data) as Finding & { status: string };
    const producedEdge = db.prepare(
      "SELECT source FROM edges WHERE target = ? AND kind = 'produced'"
    ).get(edge.source) as EdgeRow | undefined;
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

export interface BaselineResult {
  run_id: string;
  created_at: string;
  metrics: Record<string, number>;
  report_path: string;
}

export function queryBaseline(db: DatabaseSync, scopePaths: string[]): BaselineResult | null {
  const auditRows = db.prepare(
    "SELECT id, data, created_at FROM nodes WHERE kind = 'run' AND json_extract(data, '$.mode') = 'audit' AND json_extract(data, '$.status') = 'complete' ORDER BY created_at DESC"
  ).all() as unknown as NodeRow[];

  const coversStmt = db.prepare(
    "SELECT target FROM edges WHERE source = ? AND kind = 'covers'"
  );

  for (const row of auditRows) {
    const d = JSON.parse(row.data) as Run;
    const coversEdges = coversStmt.all(d.id) as Array<{ target: string }>;
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

export interface RunResult {
  run: Run;
  findings: Array<Finding & { status: string; run_id: string; resolved_by: string | null }>;
  scopes_covered: string[];
}

export function queryRun(db: DatabaseSync, runId: string): RunResult | null {
  const runRow = db.prepare(
    "SELECT data FROM nodes WHERE id = ? AND kind = 'run'"
  ).get(runId) as { data: string } | undefined;
  if (!runRow) return null;

  const run = JSON.parse(runRow.data) as Run;

  const producedEdges = db.prepare(
    "SELECT target FROM edges WHERE source = ? AND kind = 'produced'"
  ).all(runId) as Array<{ target: string }>;

  const findings: RunResult['findings'] = [];
  for (const edge of producedEdges) {
    const fRow = db.prepare(
      "SELECT data FROM nodes WHERE id = ?"
    ).get(edge.target) as { data: string } | undefined;
    if (!fRow) continue;
    const f = JSON.parse(fRow.data) as Finding & { status: string; run_id: string };
    const resolvedEdge = db.prepare(
      "SELECT source FROM edges WHERE target = ? AND kind = 'resolved'"
    ).get(f.id) as EdgeRow | undefined;
    findings.push({ ...f, resolved_by: resolvedEdge ? resolvedEdge.source : null });
  }

  const coversEdges = db.prepare(
    "SELECT target FROM edges WHERE source = ? AND kind = 'covers'"
  ).all(runId) as Array<{ target: string }>;
  const scopes_covered = coversEdges.map(e => e.target.replace(/^scope:/, ''));

  return { run, findings, scopes_covered };
}
