'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TOOL = path.join(__dirname, '..', 'bin', 'clank-tools.cjs');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clank-test-'));
  fs.mkdirSync(path.join(dir, '.clank'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'clank_reports'), { recursive: true });
  return dir;
}

function run(projectRoot, ...args) {
  const result = spawnSync('node', [TOOL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLANK_PROJECT_ROOT: projectRoot },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || (result.error && result.error.message) || 'command failed');
  }
  return result.stdout.trim();
}

function runJSON(projectRoot, ...args) {
  return JSON.parse(run(projectRoot, ...args));
}

describe('report-id', () => {
  test('produces id matching format {mode}-YYYYMMDD-HHmmss-NNN', () => {
    const dir = tmpProject();
    const id = run(dir, 'report-id', 'audit');
    assert.match(id, /^audit-\d{8}-\d{6}-\d{3}$/);
    fs.rmSync(dir, { recursive: true });
  });

  test('uses mode prefix correctly', () => {
    const dir = tmpProject();
    assert.match(run(dir, 'report-id', 'bootstrap'), /^bootstrap-/);
    assert.match(run(dir, 'report-id', 'refactor'), /^refactor-/);
    assert.match(run(dir, 'report-id', 'watch'), /^watch-/);
    fs.rmSync(dir, { recursive: true });
  });

  test('increments counter when same-second collision exists', () => {
    const dir = tmpProject();
    const id1 = run(dir, 'report-id', 'audit');
    fs.writeFileSync(path.join(dir, 'clank_reports', `${id1}.md`), '---\nid: x\n---\n');
    const id2 = run(dir, 'report-id', 'audit');
    const c1 = parseInt(id1.slice(-3), 10);
    const c2 = parseInt(id2.slice(-3), 10);
    assert.equal(c2, c1 + 1);
    fs.rmSync(dir, { recursive: true });
  });

  test('starts counter at 001 when no prior reports', () => {
    const dir = tmpProject();
    const id = run(dir, 'report-id', 'audit');
    assert.ok(id.endsWith('-001'));
    fs.rmSync(dir, { recursive: true });
  });
});
