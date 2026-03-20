#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const yaml = require('js-yaml');

const PROJECT_ROOT = process.env.CLANK_PROJECT_ROOT || process.cwd();
const CLANK_DIR = path.join(PROJECT_ROOT, '.clank');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'clank_reports');

const [,, command, ...args] = process.argv;

const commands = {
  'report-id': cmdReportId,
  'validate': cmdValidate,
  'recent': cmdRecent,
  'detect-stack': cmdDetectStack,
  'codegraph-present': cmdCodegraphPresent,
  'codegraph-fresh': cmdCodegraphFresh,
  'scratch-init': cmdScratchInit,
  'scratch-merge': cmdScratchMerge,
  'scratch-clean': cmdScratchClean,
};

if (!command || !commands[command]) {
  process.stderr.write(`Unknown command: ${command}\nAvailable: ${Object.keys(commands).join(', ')}\n`);
  process.exit(1);
}
commands[command](...args);

function parseFrontmatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return { ok: false, error: 'Missing YAML frontmatter' };
    const data = yaml.load(m[1]);
    return { ok: true, data, content };
  } catch (e) {
    return { ok: false, error: `Parse error: ${e.message}` };
  }
}

function cmdValidate(reportPath) {
  if (!reportPath) { process.stderr.write('Usage: clank-tools validate <path>\n'); process.exit(1); }
  const abs = path.isAbsolute(reportPath) ? reportPath : path.join(PROJECT_ROOT, reportPath);
  if (!fs.existsSync(abs)) {
    process.stdout.write(JSON.stringify({ valid: false, error: 'File not found' }) + '\n');
    return;
  }
  const { ok, error, data } = parseFrontmatter(abs);
  if (!ok) { process.stdout.write(JSON.stringify({ valid: false, error }) + '\n'); return; }
  if (!data || typeof data !== 'object') {
    process.stdout.write(JSON.stringify({ valid: false, error: 'Empty or invalid frontmatter' }) + '\n');
    return;
  }
  const required = ['id', 'mode', 'status', 'created_at'];
  const missing = required.filter(k => !data[k]);
  if (missing.length) {
    process.stdout.write(JSON.stringify({ valid: false, error: `Missing fields: ${missing.join(', ')}` }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ valid: true }) + '\n');
}

function extractSummary(content) {
  const m = content.match(/## Recommended Actions\n([\s\S]*?)(\n##|$)/);
  if (m) return m[1].trim().slice(0, 200);
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
  return (lines[0] || '').trim().slice(0, 200);
}

function cmdRecent(nStr) {
  const n = parseInt(nStr || '5', 10);
  if (!fs.existsSync(REPORTS_DIR)) { process.stdout.write('[]\n'); return; }
  const reports = [];
  for (const file of fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'))) {
    const { ok, data, content } = parseFrontmatter(path.join(REPORTS_DIR, file));
    if (!ok || !data?.id || !data?.mode || !data?.status || !data?.created_at) continue;
    reports.push({ id: data.id, mode: data.mode, status: data.status,
      scope: data.scope ?? null, created_at: data.created_at, summary: extractSummary(content) });
  }
  reports.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  process.stdout.write(JSON.stringify(reports.slice(0, n)) + '\n');
}

function detectInDir(dir) {
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    const deps = { ...p.dependencies, ...p.devDependencies };
    const runner = deps.vitest ? 'vitest' : deps.jest ? 'jest' : deps.mocha ? 'mocha' : deps.jasmine ? 'jasmine' : null;
    const lang = (deps.typescript || p.devDependencies?.typescript) ? 'typescript' : 'javascript';
    return { language: lang, framework: 'node', test_runner: runner, manifest_path: pkg };
  }
  const pyproj = path.join(dir, 'pyproject.toml');
  const reqtxt = path.join(dir, 'requirements.txt');
  if (fs.existsSync(pyproj) || fs.existsSync(reqtxt)) {
    return { language: 'python', framework: null, test_runner: 'pytest',
      manifest_path: fs.existsSync(pyproj) ? pyproj : reqtxt };
  }
  const cargo = path.join(dir, 'Cargo.toml');
  if (fs.existsSync(cargo)) return { language: 'rust', framework: null, test_runner: 'cargo-test', manifest_path: cargo };
  const gomod = path.join(dir, 'go.mod');
  if (fs.existsSync(gomod)) return { language: 'go', framework: null, test_runner: 'go-test', manifest_path: gomod };
  const mixexs = path.join(dir, 'mix.exs');
  if (fs.existsSync(mixexs)) return { language: 'elixir', framework: null, test_runner: 'exunit', manifest_path: mixexs };
  return null;
}

function cmdDetectStack(targetPath) {
  targetPath = targetPath || PROJECT_ROOT;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.join(PROJECT_ROOT, targetPath);
  let dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  while (true) {
    const result = detectInDir(dir);
    if (result) { process.stdout.write(JSON.stringify(result) + '\n'); return; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  process.stdout.write(JSON.stringify({ language: 'unknown', framework: null, test_runner: null, manifest_path: null }) + '\n');
}

function cmdCodegraphPresent() {
  process.stdout.write(String(fs.existsSync(path.join(PROJECT_ROOT, '.codegraph'))) + '\n');
}

function cmdCodegraphFresh() {
  const cgDir = path.join(PROJECT_ROOT, '.codegraph');
  if (!fs.existsSync(cgDir)) {
    process.stdout.write(JSON.stringify({ fresh: false, last_built: null, commits_since: 0 }) + '\n');
    return;
  }
  const lastBuilt = fs.statSync(cgDir).mtime.toISOString();
  let commitsSince = 0;
  try {
    const out = execSync(
      `git -C "${PROJECT_ROOT}" log --since="${lastBuilt}" --oneline 2>/dev/null`,
      { encoding: 'utf8' }
    );
    commitsSince = out.trim().split('\n').filter(Boolean).length;
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ fresh: false, last_built: lastBuilt, commits_since: -1, error: 'git unavailable' }) + '\n'
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({ fresh: commitsSince < 10, last_built: lastBuilt, commits_since: commitsSince }) + '\n'
  );
}

function cmdScratchInit(runId) {
  if (!runId) {
    process.stderr.write('Usage: clank-tools scratch-init <run-id>\n');
    process.exit(1);
  }
  const p = path.join(CLANK_DIR, 'scratch', runId);
  fs.mkdirSync(p, { recursive: true });
  process.stdout.write(p + '\n');
}

function cmdScratchMerge(runId) {
  if (!runId) {
    process.stderr.write('Usage: clank-tools scratch-merge <run-id>\n');
    process.exit(1);
  }
  const scratchPath = path.join(CLANK_DIR, 'scratch', runId);
  if (!fs.existsSync(scratchPath)) {
    process.stdout.write(JSON.stringify({ findings: [], errors: [] }) + '\n');
    return;
  }
  const findings = [], errors = [];
  for (const file of fs.readdirSync(scratchPath).filter(f => f.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(scratchPath, file), 'utf8'));
      if (d.status === 'complete' && Array.isArray(d.findings)) {
        findings.push(...d.findings);
      } else if (d.status === 'error') {
        errors.push({ agent_index: d.agent_index, error: d.error });
      }
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }
  process.stdout.write(JSON.stringify({ findings, errors }) + '\n');
}

function cmdScratchClean(runId) {
  if (!runId) {
    process.stderr.write('Usage: clank-tools scratch-clean <run-id>\n');
    process.exit(1);
  }
  const p = path.join(CLANK_DIR, 'scratch', runId);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true });
  }
}

function cmdReportId(mode) {
  if (!mode) { process.stderr.write('Usage: clank-tools report-id <mode>\n'); process.exit(1); }
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const prefix = `${mode}-${date}-${time}`;
  let counter = 1;
  if (fs.existsSync(REPORTS_DIR)) {
    const existing = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.md'));
    if (existing.length > 0) {
      const counters = existing.map(f => {
        const m = f.match(/-(\d{3})\.md$/);
        return m ? parseInt(m[1], 10) : 0;
      });
      counter = Math.max(...counters) + 1;
    }
  }
  process.stdout.write(`${prefix}-${String(counter).padStart(3, '0')}\n`);
}
