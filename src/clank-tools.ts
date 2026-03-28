#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';
import { querySummary } from './db.js';

const PROJECT_ROOT = process.env['CLANK_PROJECT_ROOT'] ?? process.cwd();
const CLANK_DIR = path.join(PROJECT_ROOT, '.clank');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'clank_reports');

type CommandFn = (...args: string[]) => void;

const commands: Record<string, CommandFn> = {
  'report-id': cmdReportId,
  'validate': cmdValidate,
  'recent': cmdRecent,
  'detect-stack': cmdDetectStack,
  'codegraph-present': cmdCodegraphPresent,
  'codegraph-fresh': cmdCodegraphFresh,
  'scratch-init': cmdScratchInit,
  'scratch-merge': cmdScratchMerge,
  'scratch-clean': cmdScratchClean,
  'config-get': cmdConfigGet,
  'config-set': cmdConfigSet,
  'memory-summary': cmdMemorySummary,
  'help': cmdHelp,
};

const [,, command, ...rawArgs] = process.argv;

const fn = command ? commands[command] : undefined;
if (!fn) {
  process.stderr.write(`Unknown command: ${command ?? ''}\nAvailable: ${Object.keys(commands).join(', ')}\n`);
  process.exit(1);
}
fn(...rawArgs);

// ── Helpers ───────────────────────────────────────────────────────────────────

type ParseResult =
  | { ok: true; data: Record<string, unknown>; content: string }
  | { ok: false; error: string };

function parseFrontmatter(filePath: string): ParseResult {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return { ok: false, error: 'Missing YAML frontmatter' };
    const raw: unknown = yaml.load(m[1] ?? '');
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Empty or invalid frontmatter' };
    return { ok: true, data: raw as Record<string, unknown>, content };
  } catch (e) {
    return { ok: false, error: `Parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdValidate(reportPath: string): void {
  if (!reportPath) { process.stderr.write('Usage: clank-tools validate <path>\n'); process.exit(1); }
  const abs = path.isAbsolute(reportPath) ? reportPath : path.join(PROJECT_ROOT, reportPath);
  if (!fs.existsSync(abs)) {
    process.stdout.write(JSON.stringify({ valid: false, error: 'File not found' }) + '\n');
    return;
  }
  const result = parseFrontmatter(abs);
  if (!result.ok) { process.stdout.write(JSON.stringify({ valid: false, error: result.error }) + '\n'); return; }
  const { data } = result;
  const required = ['id', 'mode', 'status', 'created_at'];
  const missing = required.filter(k => !data[k]);
  if (missing.length) {
    process.stdout.write(JSON.stringify({ valid: false, error: `Missing fields: ${missing.join(', ')}` }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ valid: true }) + '\n');
}

function extractSummary(content: string): string {
  const m = content.match(/## Recommended Actions\n([\s\S]*?)(\n##|$)/);
  if (m) return (m[1] ?? '').trim().slice(0, 200);
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
  return (lines[0] ?? '').trim().slice(0, 200);
}

function cmdRecent(nStr: string): void {
  const n = parseInt(nStr ?? '5', 10);
  if (!fs.existsSync(REPORTS_DIR)) { process.stdout.write('[]\n'); return; }
  const reports: unknown[] = [];
  for (const file of fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'))) {
    const result = parseFrontmatter(path.join(REPORTS_DIR, file));
    if (!result.ok) continue;
    const { data, content } = result;
    if (!data['id'] || !data['mode'] || !data['status'] || !data['created_at']) continue;
    reports.push({
      id: data['id'],
      mode: data['mode'],
      status: data['status'],
      scope: data['scope'] ?? null,
      created_at: data['created_at'],
      summary: extractSummary(content),
    });
  }
  reports.sort((a, b) => {
    const aDate = new Date(String((a as Record<string, unknown>)['created_at'])).getTime();
    const bDate = new Date(String((b as Record<string, unknown>)['created_at'])).getTime();
    return bDate - aDate;
  });
  process.stdout.write(JSON.stringify(reports.slice(0, n)) + '\n');
}

interface StackResult {
  language: string;
  framework: string | null;
  test_runner: string | null;
  manifest_path: string | null;
}

function detectInDir(dir: string): StackResult | null {
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    const p = JSON.parse(fs.readFileSync(pkg, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...p.dependencies, ...p.devDependencies };
    const runner = deps['vitest'] ? 'vitest'
      : deps['jest'] ? 'jest'
      : deps['mocha'] ? 'mocha'
      : deps['jasmine'] ? 'jasmine'
      : null;
    const lang = (deps['typescript'] ?? p.devDependencies?.['typescript']) ? 'typescript' : 'javascript';
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

function cmdDetectStack(targetPath: string): void {
  const resolved = targetPath ?? PROJECT_ROOT;
  const abs = path.isAbsolute(resolved) ? resolved : path.join(PROJECT_ROOT, resolved);
  let dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  for (;;) {
    const result = detectInDir(dir);
    if (result) { process.stdout.write(JSON.stringify(result) + '\n'); return; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  process.stdout.write(JSON.stringify({ language: 'unknown', framework: null, test_runner: null, manifest_path: null }) + '\n');
}

function cmdCodegraphPresent(): void {
  process.stdout.write(String(fs.existsSync(path.join(PROJECT_ROOT, '.codegraph'))) + '\n');
}

function cmdCodegraphFresh(): void {
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
  } catch {
    process.stdout.write(
      JSON.stringify({ fresh: false, last_built: lastBuilt, commits_since: -1, error: 'git unavailable' }) + '\n'
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({ fresh: commitsSince < 10, last_built: lastBuilt, commits_since: commitsSince }) + '\n'
  );
}

function cmdScratchInit(runId: string): void {
  if (!runId) { process.stderr.write('Usage: clank-tools scratch-init <run-id>\n'); process.exit(1); }
  const p = path.join(CLANK_DIR, 'scratch', runId);
  fs.mkdirSync(p, { recursive: true });
  process.stdout.write(p + '\n');
}

function cmdScratchMerge(runId: string): void {
  if (!runId) { process.stderr.write('Usage: clank-tools scratch-merge <run-id>\n'); process.exit(1); }
  const scratchPath = path.join(CLANK_DIR, 'scratch', runId);
  if (!fs.existsSync(scratchPath)) {
    process.stdout.write(JSON.stringify({ findings: [], errors: [] }) + '\n');
    return;
  }
  const findings: unknown[] = [], errors: unknown[] = [];
  for (const file of fs.readdirSync(scratchPath).filter(f => f.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(scratchPath, file), 'utf8')) as {
        status: string; findings?: unknown[]; agent_index?: number; error?: string;
      };
      if (d.status === 'complete' && Array.isArray(d.findings)) {
        findings.push(...d.findings);
      } else if (d.status === 'error') {
        errors.push({ agent_index: d.agent_index, error: d.error });
      }
    } catch (e) {
      errors.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  process.stdout.write(JSON.stringify({ findings, errors }) + '\n');
}

function cmdScratchClean(runId: string): void {
  if (!runId) { process.stderr.write('Usage: clank-tools scratch-clean <run-id>\n'); process.exit(1); }
  const p = path.join(CLANK_DIR, 'scratch', runId);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
}

function readConfig(): Record<string, unknown> {
  const p = path.join(CLANK_DIR, 'config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown> : {};
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(CLANK_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLANK_DIR, 'config.json'), JSON.stringify(cfg, null, 2));
}

function cmdConfigGet(key: string): void {
  if (!key) { process.stderr.write('Usage: clank-tools config-get <key>\n'); process.exit(1); }
  const cfg = readConfig();
  process.stdout.write(JSON.stringify(cfg[key] ?? null) + '\n');
}

function cmdConfigSet(key: string, value: string): void {
  if (!key || value === undefined) {
    process.stderr.write('Usage: clank-tools config-set <key> <value>\n'); process.exit(1);
  }
  const cfg = readConfig();
  try { cfg[key] = JSON.parse(value); } catch { cfg[key] = value; }
  writeConfig(cfg);
}

function cmdReportId(mode: string): void {
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
        return m ? parseInt(m[1] ?? '0', 10) : 0;
      });
      counter = Math.max(...counters) + 1;
    }
  }
  process.stdout.write(`${prefix}-${String(counter).padStart(3, '0')}\n`);
}

function cmdMemorySummary(): void {
  const memDbPath = path.join(CLANK_DIR, 'memory.db');
  if (!fs.existsSync(memDbPath)) {
    const reports: unknown[] = [];
    if (fs.existsSync(REPORTS_DIR)) {
      for (const file of fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'))) {
        const result = parseFrontmatter(path.join(REPORTS_DIR, file));
        if (!result.ok || !result.data['id']) continue;
        const { data } = result;
        const m = (data['metrics'] ?? {}) as Record<string, number>;
        reports.push({
          id: data['id'],
          mode: data['mode'],
          status: data['status'],
          created_at: String(data['created_at'] ?? '').slice(0, 10),
          metrics: m,
        });
      }
    }
    (reports as Array<Record<string, unknown>>).sort((a, b) =>
      String(b['created_at']).localeCompare(String(a['created_at']))
    );
    process.stdout.write(JSON.stringify({
      recent_runs: (reports as unknown[]).slice(0, 5),
      open_findings: { total: 0, blocking: 0, by_scope: {} },
    }) + '\n');
    return;
  }
  const db = new DatabaseSync(memDbPath);
  try {
    process.stdout.write(JSON.stringify(querySummary(db)) + '\n');
  } finally {
    db.close();
  }
}

function cmdHelp(): void {
  process.stdout.write(`clank-tools — Clank plugin utility

Commands:
  report-id <mode>             Generate report ID
  recent <n>                   List n most recent reports (JSON)
  detect-stack <path>          Detect language/runner for path (JSON)
  codegraph-present            Check .codegraph/ exists (boolean)
  codegraph-fresh              Check codegraph freshness (JSON)
  scratch-init <run-id>        Create scratch directory
  scratch-merge <run-id>       Merge scratch agent results (JSON)
  scratch-clean <run-id>       Delete scratch directory
  validate <report-path>       Validate report frontmatter (JSON)
  config-get <key>             Read .clank/config.json key
  config-set <key> <value>     Write .clank/config.json key
  memory-summary               Summary from memory graph (or recent .md fallback)
  help                         Show this help
`);
}
