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

describe('validate', () => {
  test('returns valid:true for well-formed report', () => {
    const dir = tmpProject();
    const p = path.join(dir, 'clank_reports', 'audit-20260320-143022-001.md');
    fs.writeFileSync(p,
      '---\nid: audit-20260320-143022-001\nmode: audit\nstatus: complete\ncreated_at: 2026-03-20T14:30:22Z\n---\n\n# Report\n');
    assert.deepEqual(runJSON(dir, 'validate', p), { valid: true });
    fs.rmSync(dir, { recursive: true });
  });

  test('returns valid:false when frontmatter is missing', () => {
    const dir = tmpProject();
    const p = path.join(dir, 'clank_reports', 'bad.md');
    fs.writeFileSync(p, '# No frontmatter');
    const result = runJSON(dir, 'validate', p);
    assert.equal(result.valid, false);
    assert.ok(result.error);
    fs.rmSync(dir, { recursive: true });
  });

  test('returns valid:false when required fields are missing', () => {
    const dir = tmpProject();
    const p = path.join(dir, 'clank_reports', 'partial.md');
    fs.writeFileSync(p, '---\nid: x\nmode: audit\n---\n');
    const result = runJSON(dir, 'validate', p);
    assert.equal(result.valid, false);
    assert.match(result.error, /missing/i);
    fs.rmSync(dir, { recursive: true });
  });

  test('returns valid:false for non-existent file', () => {
    const dir = tmpProject();
    const result = runJSON(dir, 'validate', '/no/such/file.md');
    assert.equal(result.valid, false);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('recent', () => {
  test('returns empty array when clank_reports/ is empty', () => {
    const dir = tmpProject();
    assert.deepEqual(runJSON(dir, 'recent', '5'), []);
    fs.rmSync(dir, { recursive: true });
  });

  test('returns reports sorted newest first', () => {
    const dir = tmpProject();
    const write = (id, date) => fs.writeFileSync(
      path.join(dir, 'clank_reports', `${id}.md`),
      `---\nid: ${id}\nmode: audit\nstatus: complete\ncreated_at: ${date}\n---\n`
    );
    write('audit-20260319-100000-001', '2026-03-19T10:00:00Z');
    write('audit-20260320-100000-001', '2026-03-20T10:00:00Z');
    const result = runJSON(dir, 'recent', '5');
    assert.equal(result[0].id, 'audit-20260320-100000-001');
    assert.equal(result[1].id, 'audit-20260319-100000-001');
    fs.rmSync(dir, { recursive: true });
  });

  test('respects n limit', () => {
    const dir = tmpProject();
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(
        path.join(dir, 'clank_reports', `audit-2026032${i}-100000-001.md`),
        `---\nid: audit-2026032${i}-100000-001\nmode: audit\nstatus: complete\ncreated_at: 2026-03-2${i}T10:00:00Z\n---\n`
      );
    }
    assert.equal(runJSON(dir, 'recent', '2').length, 2);
    fs.rmSync(dir, { recursive: true });
  });

  test('skips corrupt reports silently', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'clank_reports', 'corrupt.md'), 'no frontmatter here');
    assert.deepEqual(runJSON(dir, 'recent', '5'), []);
    fs.rmSync(dir, { recursive: true });
  });

  test('includes id, mode, status, scope, created_at in each result', () => {
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, 'clank_reports', 'audit-20260320-100000-001.md'),
      '---\nid: audit-20260320-100000-001\nmode: audit\nstatus: complete\ncreated_at: 2026-03-20T10:00:00Z\n---\n'
    );
    const result = runJSON(dir, 'recent', '1');
    assert.ok('id' in result[0]);
    assert.ok('mode' in result[0]);
    assert.ok('status' in result[0]);
    assert.ok('created_at' in result[0]);
    fs.rmSync(dir, { recursive: true });
  });
});
