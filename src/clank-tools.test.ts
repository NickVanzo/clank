import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { initDb, recordRun } from './db.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TOOL = path.join(__dirname, '..', 'dist', 'clank-tools.js');

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clank-test-'));
  fs.mkdirSync(path.join(dir, '.clank'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'clank_reports'), { recursive: true });
  return dir;
}

function run(projectRoot: string, ...args: string[]): string {
  const result = spawnSync('node', [TOOL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLANK_PROJECT_ROOT: projectRoot },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || 'command failed');
  }
  return result.stdout.trim();
}

function runJSON(projectRoot: string, ...args: string[]): unknown {
  return JSON.parse(run(projectRoot, ...args));
}

describe('report-id', () => {
  test('produces id matching format {mode}-YYYYMMDD-HHmmss-NNN', () => {
    const dir = tmpProject();
    const id = run(dir, 'report-id', 'audit');
    expect(id).toMatch(/^audit-\d{8}-\d{6}-\d{3}$/);
    fs.rmSync(dir, { recursive: true });
  });

  test('uses mode prefix correctly', () => {
    const dir = tmpProject();
    expect(run(dir, 'report-id', 'bootstrap')).toMatch(/^bootstrap-/);
    expect(run(dir, 'report-id', 'refactor')).toMatch(/^refactor-/);
    expect(run(dir, 'report-id', 'watch')).toMatch(/^watch-/);
    fs.rmSync(dir, { recursive: true });
  });

  test('increments counter when same-second collision exists', () => {
    const dir = tmpProject();
    const id1 = run(dir, 'report-id', 'audit');
    fs.writeFileSync(path.join(dir, 'clank_reports', `${id1}.md`), '---\nid: x\n---\n');
    const id2 = run(dir, 'report-id', 'audit');
    const c1 = parseInt(id1.slice(-3), 10);
    const c2 = parseInt(id2.slice(-3), 10);
    expect(c2).toBe(c1 + 1);
    fs.rmSync(dir, { recursive: true });
  });

  test('starts counter at 001 when no prior reports', () => {
    const dir = tmpProject();
    expect(run(dir, 'report-id', 'audit')).toMatch(/-001$/);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('validate', () => {
  test('returns valid:true for well-formed report', () => {
    const dir = tmpProject();
    const p = path.join(dir, 'clank_reports', 'audit-20260320-143022-001.md');
    fs.writeFileSync(p,
      '---\nid: audit-20260320-143022-001\nmode: audit\nstatus: complete\ncreated_at: 2026-03-20T14:30:22Z\n---\n\n# Report\n');
    expect(runJSON(dir, 'validate', p)).toEqual({ valid: true });
    fs.rmSync(dir, { recursive: true });
  });

  test('returns valid:false when frontmatter is missing', () => {
    const dir = tmpProject();
    const p = path.join(dir, 'clank_reports', 'bad.md');
    fs.writeFileSync(p, '# No frontmatter');
    const result = runJSON(dir, 'validate', p) as { valid: boolean; error: string };
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns valid:false when required fields are missing', () => {
    const dir = tmpProject();
    const p = path.join(dir, 'clank_reports', 'partial.md');
    fs.writeFileSync(p, '---\nid: x\nmode: audit\n---\n');
    const result = runJSON(dir, 'validate', p) as { valid: boolean; error: string };
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/missing/i);
    fs.rmSync(dir, { recursive: true });
  });

  test('returns valid:false for non-existent file', () => {
    const dir = tmpProject();
    expect((runJSON(dir, 'validate', '/no/such/file.md') as { valid: boolean }).valid).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('recent', () => {
  test('returns empty array when clank_reports/ is empty', () => {
    const dir = tmpProject();
    expect(runJSON(dir, 'recent', '5')).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });

  test('returns reports sorted newest first', () => {
    const dir = tmpProject();
    const write = (id: string, date: string) => fs.writeFileSync(
      path.join(dir, 'clank_reports', `${id}.md`),
      `---\nid: ${id}\nmode: audit\nstatus: complete\ncreated_at: ${date}\n---\n`
    );
    write('audit-20260319-100000-001', '2026-03-19T10:00:00Z');
    write('audit-20260320-100000-001', '2026-03-20T10:00:00Z');
    const result = runJSON(dir, 'recent', '5') as Array<{ id: string }>;
    expect(result[0]?.id).toBe('audit-20260320-100000-001');
    expect(result[1]?.id).toBe('audit-20260319-100000-001');
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
    expect((runJSON(dir, 'recent', '2') as unknown[]).length).toBe(2);
    fs.rmSync(dir, { recursive: true });
  });

  test('skips corrupt reports silently', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'clank_reports', 'corrupt.md'), 'no frontmatter here');
    expect(runJSON(dir, 'recent', '5')).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });

  test('includes id, mode, status, scope, created_at in each result', () => {
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, 'clank_reports', 'audit-20260320-100000-001.md'),
      '---\nid: audit-20260320-100000-001\nmode: audit\nstatus: complete\ncreated_at: 2026-03-20T10:00:00Z\n---\n'
    );
    const result = runJSON(dir, 'recent', '1') as Array<Record<string, unknown>>;
    expect('id' in (result[0] ?? {})).toBe(true);
    expect('mode' in (result[0] ?? {})).toBe(true);
    expect('status' in (result[0] ?? {})).toBe(true);
    expect('created_at' in (result[0] ?? {})).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('detect-stack', () => {
  test('detects typescript/vitest', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '1.0.0', typescript: '5.0.0' } }));
    const r = runJSON(dir, 'detect-stack', dir) as { language: string; test_runner: string };
    expect(r.language).toBe('typescript');
    expect(r.test_runner).toBe('vitest');
    fs.rmSync(dir, { recursive: true });
  });

  test('detects javascript/jest', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '29.0.0' } }));
    const r = runJSON(dir, 'detect-stack', dir) as { language: string; test_runner: string };
    expect(r.language).toBe('javascript');
    expect(r.test_runner).toBe('jest');
    fs.rmSync(dir, { recursive: true });
  });

  test('detects python/pytest from pyproject.toml', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[build-system]\n');
    const r = runJSON(dir, 'detect-stack', dir) as { language: string; test_runner: string };
    expect(r.language).toBe('python');
    expect(r.test_runner).toBe('pytest');
    fs.rmSync(dir, { recursive: true });
  });

  test('detects rust/cargo-test', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "foo"\n');
    const r = runJSON(dir, 'detect-stack', dir) as { language: string; test_runner: string };
    expect(r.language).toBe('rust');
    expect(r.test_runner).toBe('cargo-test');
    fs.rmSync(dir, { recursive: true });
  });

  test('detects go/go-test', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\n');
    const r = runJSON(dir, 'detect-stack', dir) as { language: string; test_runner: string };
    expect(r.language).toBe('go');
    expect(r.test_runner).toBe('go-test');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns unknown for project with no manifest', () => {
    const dir = tmpProject();
    const r = runJSON(dir, 'detect-stack', dir) as { language: string };
    expect(r.language).toBe('unknown');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns null test_runner for package.json with no known runner', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '5.0.0' } }));
    const r = runJSON(dir, 'detect-stack', dir) as { language: string; test_runner: string | null };
    expect(r.language).toBe('typescript');
    expect(r.test_runner).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  test('walks up from nested path to find manifest', () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '29.0.0' } }));
    const r = runJSON(dir, 'detect-stack', path.join(dir, 'src', 'utils')) as { test_runner: string };
    expect(r.test_runner).toBe('jest');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns manifest_path', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: {} }));
    const r = runJSON(dir, 'detect-stack', dir) as { manifest_path: string };
    expect(r.manifest_path).toBeTruthy();
    expect(r.manifest_path.endsWith('package.json')).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('codegraph-present', () => {
  test('returns false when .codegraph/ absent', () => {
    const dir = tmpProject();
    expect(run(dir, 'codegraph-present')).toBe('false');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns true when .codegraph/ exists', () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, '.codegraph'));
    expect(run(dir, 'codegraph-present')).toBe('true');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('codegraph-fresh', () => {
  test('returns fresh:false when .codegraph/ absent', () => {
    const dir = tmpProject();
    const r = runJSON(dir, 'codegraph-fresh') as { fresh: boolean; last_built: null };
    expect(r.fresh).toBe(false);
    expect(r.last_built).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  test('returns last_built timestamp when .codegraph/ exists', () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, '.codegraph'));
    const r = runJSON(dir, 'codegraph-fresh') as { last_built: string; commits_since: number };
    expect(r.last_built).toBeTruthy();
    expect(typeof r.commits_since).toBe('number');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('scratch management', () => {
  test('scratch-init creates directory and returns path', () => {
    const dir = tmpProject();
    const result = run(dir, 'scratch-init', 'run-001');
    expect(fs.existsSync(result)).toBe(true);
    expect(result).toContain('run-001');
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-merge merges findings from multiple complete agents', () => {
    const dir = tmpProject();
    const scratchDir = run(dir, 'scratch-init', 'run-merge');
    fs.writeFileSync(path.join(scratchDir, '0.json'),
      JSON.stringify({ agent_index: 0, status: 'complete', findings: [{ type: 'gap', file: 'a.ts' }], error: null }));
    fs.writeFileSync(path.join(scratchDir, '1.json'),
      JSON.stringify({ agent_index: 1, status: 'complete', findings: [{ type: 'gap', file: 'b.ts' }], error: null }));
    const r = runJSON(dir, 'scratch-merge', 'run-merge') as { findings: unknown[]; errors: unknown[] };
    expect(r.findings).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-merge captures errors from failed agents', () => {
    const dir = tmpProject();
    const scratchDir = run(dir, 'scratch-init', 'run-err');
    fs.writeFileSync(path.join(scratchDir, '0.json'),
      JSON.stringify({ agent_index: 0, status: 'error', findings: [], error: 'CodeGraph unavailable' }));
    const r = runJSON(dir, 'scratch-merge', 'run-err') as { errors: Array<{ error: string }> };
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.error).toBe('CodeGraph unavailable');
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-merge returns empty for non-existent run', () => {
    const dir = tmpProject();
    expect(runJSON(dir, 'scratch-merge', 'no-such-run')).toEqual({ findings: [], errors: [] });
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-clean removes directory', () => {
    const dir = tmpProject();
    const scratchDir = run(dir, 'scratch-init', 'run-clean');
    expect(fs.existsSync(scratchDir)).toBe(true);
    run(dir, 'scratch-clean', 'run-clean');
    expect(fs.existsSync(scratchDir)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  test('scratch-clean is idempotent', () => {
    const dir = tmpProject();
    run(dir, 'scratch-clean', 'non-existent');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('config management', () => {
  test('config-get returns null string for missing key', () => {
    const dir = tmpProject();
    expect(run(dir, 'config-get', 'missing_key')).toBe('null');
    fs.rmSync(dir, { recursive: true });
  });

  test('config-get returns null string when config.json absent', () => {
    const dir = tmpProject();
    fs.rmSync(path.join(dir, '.clank'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.clank'));
    expect(run(dir, 'config-get', 'anything')).toBe('null');
    fs.rmSync(dir, { recursive: true });
  });

  test('config-set and config-get roundtrip boolean', () => {
    const dir = tmpProject();
    run(dir, 'config-set', 'codegraph_suggestion_shown', 'true');
    expect(run(dir, 'config-get', 'codegraph_suggestion_shown')).toBe('true');
    fs.rmSync(dir, { recursive: true });
  });

  test('config-set and config-get roundtrip string', () => {
    const dir = tmpProject();
    run(dir, 'config-set', 'last_audit', '"audit-20260320-001"');
    expect(run(dir, 'config-get', 'last_audit')).toBe('"audit-20260320-001"');
    fs.rmSync(dir, { recursive: true });
  });

  test('config-set preserves existing keys', () => {
    const dir = tmpProject();
    run(dir, 'config-set', 'key_a', '"a"');
    run(dir, 'config-set', 'key_b', '"b"');
    expect(run(dir, 'config-get', 'key_a')).toBe('"a"');
    expect(run(dir, 'config-get', 'key_b')).toBe('"b"');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('memory-summary', () => {
  test('returns empty state when memory.db does not exist (falls back to .md scan)', () => {
    const dir = tmpProject();
    const result = runJSON(dir, 'memory-summary') as { recent_runs: unknown[]; open_findings: { total: number } };
    expect(Array.isArray(result.recent_runs)).toBe(true);
    expect(result.open_findings.total).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });

  test('returns summary from memory.db when it exists', () => {
    const dir = tmpProject();
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

    const result = runJSON(dir, 'memory-summary') as { recent_runs: Array<{ id: string }> };
    expect(result.recent_runs).toHaveLength(1);
    expect(result.recent_runs[0]?.id).toBe('audit-20260320-100000-001');
    fs.rmSync(dir, { recursive: true });
  });
});
