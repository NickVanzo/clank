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
 *
 * @param {string} projectRoot - Absolute path to the project root directory.
 * @returns {DatabaseSync}
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
 * Write a completed run + findings into the graph as a single atomic transaction.
 *
 * @param {DatabaseSync} db
 * @param {{ run: object, findings: object[], resolved_finding_ids: string[] }} input
 * @param {number} [_createdAt] - Unix ms timestamp; defaults to Date.now().
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

module.exports = { initDb, recordRun, querySummary, queryScope, queryBaseline, queryRun };
