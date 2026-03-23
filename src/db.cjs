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

module.exports = { initDb, recordRun };
