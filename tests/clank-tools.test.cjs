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

describe('detect-stack', () => {
  test('detects typescript/vitest', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '1.0.0', typescript: '5.0.0' } }));
    const r = runJSON(dir, 'detect-stack', dir);
    assert.equal(r.language, 'typescript');
    assert.equal(r.test_runner, 'vitest');
    fs.rmSync(dir, { recursive: true });
  });

  test('detects javascript/jest', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '29.0.0' } }));
    const r = runJSON(dir, 'detect-stack', dir);
    assert.equal(r.language, 'javascript');
    assert.equal(r.test_runner, 'jest');
    fs.rmSync(dir, { recursive: true });
  });

  test('detects python/pytest from pyproject.toml', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[build-system]\n');
    const r = runJSON(dir, 'detect-stack', dir);
    assert.equal(r.language, 'python');
    assert.equal(r.test_runner, 'pytest');
    fs.rmSync(dir, { recursive: true });
  });

  test('detects rust/cargo-test', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "foo"\n');
    const r = runJSON(dir, 'detect-stack', dir);
    assert.equal(r.language, 'rust');
    assert.equal(r.test_runner, 'cargo-test');
    fs.rmSync(dir, { recursive: true });
  });

  test('detects go/go-test', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\n');
    const r = runJSON(dir, 'detect-stack', dir);
    assert.equal(r.language, 'go');
    assert.equal(r.test_runner, 'go-test');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns unknown for project with no manifest', () => {
    const dir = tmpProject();
    const r = runJSON(dir, 'detect-stack', dir);
    assert.equal(r.language, 'unknown');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns null test_runner for package.json with no known runner', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '5.0.0' } }));
    const r = runJSON(dir, 'detect-stack', dir);
    assert.equal(r.language, 'typescript');
    assert.equal(r.test_runner, null);
    fs.rmSync(dir, { recursive: true });
  });

  test('walks up from nested path to find manifest', () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '29.0.0' } }));
    const r = runJSON(dir, 'detect-stack', path.join(dir, 'src', 'utils'));
    assert.equal(r.test_runner, 'jest');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns manifest_path', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: {} }));
    const r = runJSON(dir, 'detect-stack', dir);
    assert.ok(r.manifest_path);
    assert.ok(r.manifest_path.endsWith('package.json'));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('codegraph-present', () => {
  test('returns false when .codegraph/ absent', () => {
    const dir = tmpProject();
    assert.equal(run(dir, 'codegraph-present'), 'false');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns true when .codegraph/ exists', () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, '.codegraph'));
    assert.equal(run(dir, 'codegraph-present'), 'true');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('codegraph-fresh', () => {
  test('returns fresh:false when .codegraph/ absent', () => {
    const dir = tmpProject();
    const r = runJSON(dir, 'codegraph-fresh');
    assert.equal(r.fresh, false);
    assert.equal(r.last_built, null);
    fs.rmSync(dir, { recursive: true });
  });

  test('returns last_built timestamp when .codegraph/ exists', () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, '.codegraph'));
    const r = runJSON(dir, 'codegraph-fresh');
    assert.ok(r.last_built);
    assert.ok(typeof r.commits_since === 'number');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('scratch management', () => {
  test('scratch-init creates directory and returns path', () => {
    const dir = tmpProject();
    const result = run(dir, 'scratch-init', 'run-001');
    assert.ok(fs.existsSync(result));
    assert.ok(result.includes('run-001'));
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-merge merges findings from multiple complete agents', () => {
    const dir = tmpProject();
    const scratchDir = run(dir, 'scratch-init', 'run-merge');
    fs.writeFileSync(path.join(scratchDir, '0.json'),
      JSON.stringify({ agent_index: 0, status: 'complete', findings: [{ type: 'gap', file: 'a.ts' }], error: null }));
    fs.writeFileSync(path.join(scratchDir, '1.json'),
      JSON.stringify({ agent_index: 1, status: 'complete', findings: [{ type: 'gap', file: 'b.ts' }], error: null }));
    const r = runJSON(dir, 'scratch-merge', 'run-merge');
    assert.equal(r.findings.length, 2);
    assert.equal(r.errors.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-merge captures errors from failed agents', () => {
    const dir = tmpProject();
    const scratchDir = run(dir, 'scratch-init', 'run-err');
    fs.writeFileSync(path.join(scratchDir, '0.json'),
      JSON.stringify({ agent_index: 0, status: 'error', findings: [], error: 'CodeGraph unavailable' }));
    const r = runJSON(dir, 'scratch-merge', 'run-err');
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].error, 'CodeGraph unavailable');
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-merge returns empty for non-existent run', () => {
    const dir = tmpProject();
    const r = runJSON(dir, 'scratch-merge', 'no-such-run');
    assert.deepEqual(r, { findings: [], errors: [] });
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-clean removes directory', () => {
    const dir = tmpProject();
    const scratchDir = run(dir, 'scratch-init', 'run-clean');
    assert.ok(fs.existsSync(scratchDir));
    run(dir, 'scratch-clean', 'run-clean');
    assert.ok(!fs.existsSync(scratchDir));
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-clean is idempotent', () => {
    const dir = tmpProject();
    run(dir, 'scratch-clean', 'non-existent');
    // No error thrown
    fs.rmSync(dir, { recursive: true });
  });
});

describe('config management', () => {
  test('config-get returns null string for missing key', () => {
    const dir = tmpProject();
    assert.equal(run(dir, 'config-get', 'missing_key'), 'null');
    fs.rmSync(dir, { recursive: true });
  });

  test('config-get returns null string when config.json absent', () => {
    const dir = tmpProject();
    fs.rmSync(path.join(dir, '.clank'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.clank'));
    assert.equal(run(dir, 'config-get', 'anything'), 'null');
    fs.rmSync(dir, { recursive: true });
  });

  test('config-set and config-get roundtrip boolean', () => {
    const dir = tmpProject();
    run(dir, 'config-set', 'codegraph_suggestion_shown', 'true');
    assert.equal(run(dir, 'config-get', 'codegraph_suggestion_shown'), 'true');
    fs.rmSync(dir, { recursive: true });
  });

  test('config-set and config-get roundtrip string', () => {
    const dir = tmpProject();
    run(dir, 'config-set', 'last_audit', '"audit-20260320-001"');
    assert.equal(run(dir, 'config-get', 'last_audit'), '"audit-20260320-001"');
    fs.rmSync(dir, { recursive: true });
  });

  test('config-set preserves existing keys', () => {
    const dir = tmpProject();
    run(dir, 'config-set', 'key_a', '"a"');
    run(dir, 'config-set', 'key_b', '"b"');
    assert.equal(run(dir, 'config-get', 'key_a'), '"a"');
    assert.equal(run(dir, 'config-get', 'key_b'), '"b"');
    fs.rmSync(dir, { recursive: true });
  });
});
