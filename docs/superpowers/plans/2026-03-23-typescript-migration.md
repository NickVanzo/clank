# TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all clank source files from CommonJS JavaScript to TypeScript + ESM after merging the memory-graph PR.

**Architecture:** Source files move from `bin/` + `src/` into a unified `src/` directory as `.ts` files. `tsc` compiles to `dist/`. Tests colocate with source and switch from `node:test` to `vitest`. The `clank-tools.test.ts` spawns the compiled binary, so a `pretest` build step ensures `dist/` is current before vitest runs.

**Tech Stack:** TypeScript 5.x, Node 22 ESM (`"type": "module"`), `tsc` for compilation, `vitest` for tests, `oxlint` for linting, `tsx` for dev execution.

**Spec:** `docs/superpowers/specs/2026-03-23-typescript-migration-design.md`

---

### Task 1: Merge memory-graph PR and create migration branch

**Files:**
- Git operations only

- [ ] **Step 1: Merge memory-graph PR to main**

```bash
git checkout main
git merge feat/memory-graph --no-ff -m "feat: add memory graph for persistent audit run tracking"
```

- [ ] **Step 2: Verify tests still pass on main**

```bash
npm test
```
Expected: all 65 tests pass

- [ ] **Step 3: Create migration branch**

```bash
git checkout -b feat/typescript-migration
```

- [ ] **Step 4: Commit (branch creation is the commit)**

```bash
git log --oneline -3
```

---

### Task 2: Set up TypeScript tooling

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.oxlintrc.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install devDependencies**

```bash
npm install --save-dev typescript@latest @types/node@^22.10.0 tsx vitest oxlint
```

Note: `@types/node` 22.7.0+ includes types for `node:sqlite`. `@types/better-sqlite3` is NOT needed — clank uses Node's built-in `node:sqlite`, not the npm package.

- [ ] **Step 2: Replace `package.json`**

```json
{
  "name": "clank",
  "version": "0.2.0",
  "description": "Test suite lifecycle management plugin for Claude Code",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "pretest": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "oxlint src"
  },
  "bin": {
    "clank-tools": "./dist/clank-tools.js",
    "clank": "./dist/clank.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.10.2",
    "js-yaml": "4.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "oxlint": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  },
  "engines": {
    "node": ">=22.5.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({});
```

Note: vitest loads this via its own esbuild transform, outside `tsconfig.json`'s `include: ["src"]`. Type checking is done by `tsc --noEmit`, not vitest.

- [ ] **Step 5: Create `.oxlintrc.json`**

```json
{
  "plugins": ["typescript", "import", "unicorn"],
  "rules": {}
}
```

- [ ] **Step 6: Add `dist/` to `.gitignore`**

Append to `.gitignore`:
```
dist/
```

- [ ] **Step 7: Verify tooling is installed**

```bash
npx tsc --version
npx vitest --version
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .oxlintrc.json .gitignore
git commit -m "chore: set up TypeScript, vitest, and oxlint tooling"
```

---

### Task 3: Migrate src/db.ts

**Files:**
- Create: `src/db.ts`
- Delete: `src/db.cjs`

- [ ] **Step 1: Create `src/db.ts`**

```ts
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
  ).all(n) as NodeRow[];

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
  ).all() as EdgeRow[];

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
  ).all() as NodeRow[];

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
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: zero errors (db.ts compiles cleanly; no other .ts files yet so "no inputs" error is OK — add `"noEmitOnError": false` temporarily if needed or create a stub)

- [ ] **Step 3: Delete old file**

```bash
rm src/db.cjs
```

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/db.cjs
git commit -m "feat: migrate src/db.cjs to TypeScript ESM"
```

---

### Task 4: Migrate src/install.ts

**Files:**
- Create: `src/install.ts`
- Delete: `bin/install.js`

- [ ] **Step 1: Create `src/install.ts`**

```ts
#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOME = os.homedir();
const PROJECT_ROOT = process.env['CLANK_INSTALL_PROJECT'] ?? process.cwd();

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readJson(p: string): Record<string, unknown> {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown> : {};
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function writeMcpConfig(claudeJsonPath: string): void {
  const cfg = readJson(claudeJsonPath);
  const servers = (cfg['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  servers['clank'] = { type: 'stdio', command: 'clank', args: ['serve', '--mcp'] };
  cfg['mcpServers'] = servers;
  writeJson(claudeJsonPath, cfg);
}

function writePermissions(settingsPath: string): void {
  const s = readJson(settingsPath);
  const perms = (s['permissions'] as Record<string, unknown> | undefined) ?? {};
  const allow = (perms['allow'] as string[] | undefined) ?? [];
  const tools = [
    'mcp__clank__clank_memory_record',
    'mcp__clank__clank_memory_summary',
    'mcp__clank__clank_memory_scope',
    'mcp__clank__clank_memory_baseline',
    'mcp__clank__clank_memory_run',
  ];
  for (const t of tools) {
    if (!allow.includes(t)) allow.push(t);
  }
  perms['allow'] = allow;
  s['permissions'] = perms;
  writeJson(settingsPath, s);
}

function writeSessionStartHook(settingsPath: string): void {
  const s = readJson(settingsPath);
  const hooks = (s['hooks'] as Record<string, unknown> | undefined) ?? {};
  let sessionStart = (hooks['SessionStart'] as unknown[] | undefined) ?? [];
  sessionStart = sessionStart.filter(
    e => !JSON.stringify(e).includes('clank-tools memory-summary')
  );
  sessionStart.push({
    matcher: '.*',
    hooks: [{ type: 'command', command: 'clank-tools memory-summary' }],
  });
  hooks['SessionStart'] = sessionStart;
  s['hooks'] = hooks;
  writeJson(settingsPath, s);
}

const CLAUDE_MD_SECTION_START = '<!-- clank-memory:start -->';
const CLAUDE_MD_SECTION_END = '<!-- clank-memory:end -->';
const CLAUDE_MD_CONTENT = `${CLAUDE_MD_SECTION_START}
## Clank Memory Graph

When working in a Clank-enabled project (.clank/ exists), use these MCP tools instead of reading report files:

| Tool | When to use |
|------|-------------|
| \`mcp__clank__clank_memory_record\` | At the end of every Clank run, after writing the Markdown report |
| \`mcp__clank__clank_memory_summary\` | At session start or to get project health overview |
| \`mcp__clank__clank_memory_scope\` | Before analyzing a file, to load prior findings |
| \`mcp__clank__clank_memory_baseline\` | At watch start, to find the best prior audit |
| \`mcp__clank__clank_memory_run\` | When full run detail is needed beyond the summary |

All tools accept an optional \`projectPath\` parameter. Defaults to cwd.
${CLAUDE_MD_SECTION_END}`;

function writeClaudeMd(claudeMdPath: string): void {
  fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, CLAUDE_MD_CONTENT + '\n');
    return;
  }
  let content = fs.readFileSync(claudeMdPath, 'utf8');
  if (content.includes(CLAUDE_MD_SECTION_START)) {
    const start = content.indexOf(CLAUDE_MD_SECTION_START);
    const end = content.indexOf(CLAUDE_MD_SECTION_END) + CLAUDE_MD_SECTION_END.length;
    content = content.slice(0, start) + CLAUDE_MD_CONTENT + content.slice(end);
  } else {
    content = content.trimEnd() + '\n\n' + CLAUDE_MD_CONTENT + '\n';
  }
  fs.writeFileSync(claudeMdPath, content);
}

function initProjectClankDir(projectRoot: string): void {
  const clankDir = path.join(projectRoot, '.clank');
  fs.mkdirSync(path.join(clankDir, 'journals'), { recursive: true });
  fs.mkdirSync(path.join(clankDir, 'scratch'), { recursive: true });
  const configPath = path.join(clankDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      codegraph_suggestion_shown: false,
      last_audit: null, last_bootstrap: null, last_refactor: null, last_watch: null,
      test_run_command: null,
    }, null, 2));
  }
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = '.clank/memory.db';
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, 'utf8');
    if (!existing.includes(entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`);
    }
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`);
  }
}

async function main(): Promise<void> {
  console.log('\nClank installer\n');

  const locationAnswer = await ask('Install globally (~/.claude) or locally (./.claude)? [G/l] ');
  const isLocal = locationAnswer.toLowerCase() === 'l';
  const claudeDir = isLocal ? path.join(PROJECT_ROOT, '.claude') : path.join(HOME, '.claude');
  const claudeJsonPath = isLocal
    ? path.join(PROJECT_ROOT, '.claude.json')
    : path.join(HOME, '.claude.json');
  const settingsPath = path.join(claudeDir, 'settings.json');

  console.log('Installing clank globally...');
  execSync(`npm install -g "${PLUGIN_ROOT}"`, { stdio: 'inherit' });
  console.log('✓ clank installed globally');

  const CLAUDE_LOCAL = path.join(PROJECT_ROOT, '.claude');
  copyDir(path.join(PLUGIN_ROOT, 'commands', 'clank'), path.join(CLAUDE_LOCAL, 'commands', 'clank'));
  console.log('✓ commands/clank/');
  copyDir(path.join(PLUGIN_ROOT, 'agents'), path.join(CLAUDE_LOCAL, 'agents'));
  console.log('✓ agents/');
  copyDir(path.join(PLUGIN_ROOT, 'clank'), path.join(path.join(HOME, '.claude'), 'clank'));
  console.log('✓ ~/.claude/clank/');
  copyDir(path.join(PLUGIN_ROOT, 'dist'), path.join(path.join(HOME, '.claude'), 'clank', 'dist'));
  console.log('✓ ~/.claude/clank/dist/');

  writeMcpConfig(claudeJsonPath);
  console.log(`✓ MCP server registered in ${isLocal ? './.claude.json' : '~/.claude.json'}`);

  const allowAnswer = await ask('Auto-allow clank_memory_* MCP tools? [Y/n] ');
  if (allowAnswer.toLowerCase() !== 'n') {
    writePermissions(settingsPath);
    console.log(`✓ Permissions added to ${isLocal ? './.claude/settings.json' : '~/.claude/settings.json'}`);
  }

  writeSessionStartHook(settingsPath);
  console.log('✓ SessionStart hook registered');

  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  writeClaudeMd(claudeMdPath);
  console.log('✓ CLAUDE.md updated');

  initProjectClankDir(PROJECT_ROOT);
  console.log('✓ .clank/ initialized in project');

  console.log('\nClank installed. Restart Claude Code to load the MCP server. Run /clank:audit to get started.\n');
}

main().catch((err: unknown) => {
  console.error('Installation failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

Note: `copyDir(... 'bin' ...)` is replaced with `copyDir(... 'dist' ...)` since the compiled outputs are now in `dist/`.

- [ ] **Step 2: Delete old file**

```bash
rm bin/install.js
```

- [ ] **Step 3: Compile and verify no errors**

```bash
npx tsc -p tsconfig.json
```
Expected: `dist/install.js` created, zero errors

- [ ] **Step 4: Commit**

```bash
git add src/install.ts bin/install.js
git commit -m "feat: migrate bin/install.js to TypeScript ESM"
```

---

### Task 5: Migrate src/clank.ts

**Files:**
- Create: `src/clank.ts`
- Delete: `bin/clank.cjs`

- [ ] **Step 1: Create `src/clank.ts`**

```ts
#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);

if (args[0] === 'serve' && args[1] === '--mcp') {
  await runMcpServer();
} else {
  runInstaller();
}

async function runMcpServer(): Promise<void> {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { initDb, recordRun, querySummary, queryScope, queryBaseline, queryRun } = await import('./db.js');

  const server = new Server(
    { name: 'clank', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'clank_memory_record',
        description: 'Record a completed Clank run and its findings into the memory graph. Call at the end of every mode (audit, bootstrap, refactor, watch).',
        inputSchema: {
          type: 'object',
          properties: {
            run: { type: 'object', description: 'Run metadata object' },
            findings: { type: 'array', description: 'Array of finding objects from this run' },
            resolved_finding_ids: { type: 'array', description: 'IDs of findings resolved by this run (refactor only; empty for other modes)' },
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
          required: ['run', 'findings', 'resolved_finding_ids'],
        },
      },
      {
        name: 'clank_memory_summary',
        description: 'Compact overview of recent runs and open finding counts. Use at session start to understand current project state.',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
        },
      },
      {
        name: 'clank_memory_scope',
        description: 'Finding history for a specific file or directory path. Call before analyzing a file to load prior context.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File or directory path to query' },
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'clank_memory_baseline',
        description: 'Find the most recent complete audit run covering the given scope paths. Use at watch start to find the baseline.',
        inputSchema: {
          type: 'object',
          properties: {
            scope_paths: { type: 'array', description: 'Array of paths the watch run will cover' },
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
          required: ['scope_paths'],
        },
      },
      {
        name: 'clank_memory_run',
        description: 'Full detail for a specific run: run metadata, all findings, scopes covered.',
        inputSchema: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'The run ID to retrieve' },
            projectPath: { type: 'string', description: 'Path to project root. Defaults to cwd.' },
          },
          required: ['run_id'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    const args = toolArgs as Record<string, unknown>;
    const projectRoot = typeof args['projectPath'] === 'string' ? args['projectPath'] : process.cwd();

    let db;
    try {
      db = initDb(projectRoot);
      let result: unknown;

      if (name === 'clank_memory_record') {
        recordRun(db, {
          run: args['run'] as Parameters<typeof recordRun>[1]['run'],
          findings: args['findings'] as Parameters<typeof recordRun>[1]['findings'],
          resolved_finding_ids: args['resolved_finding_ids'] as string[],
        });
        result = { ok: true };
      } else if (name === 'clank_memory_summary') {
        result = querySummary(db);
      } else if (name === 'clank_memory_scope') {
        result = queryScope(db, args['path'] as string);
      } else if (name === 'clank_memory_baseline') {
        result = queryBaseline(db, args['scope_paths'] as string[]);
      } else if (name === 'clank_memory_run') {
        result = queryRun(db, args['run_id'] as string);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
        isError: true,
      };
    } finally {
      if (db) db.close();
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function runInstaller(): void {
  const installScript = fileURLToPath(new URL('./install.js', import.meta.url));
  execSync(`node "${installScript}"`, { stdio: 'inherit' });
}
```

Note: Top-level `await` is valid in ESM modules. `runMcpServer()` is made `async` and awaited at top level. Dynamic imports are used inside `runMcpServer` to avoid loading the MCP SDK and db module when the binary is invoked as the installer.

- [ ] **Step 2: Delete old file**

```bash
rm bin/clank.cjs
```

- [ ] **Step 3: Compile and verify**

```bash
npx tsc -p tsconfig.json
```
Expected: `dist/clank.js` and `dist/install.js` in `dist/`, zero errors

- [ ] **Step 4: Smoke test the installer path works**

```bash
node dist/clank.js --help 2>&1 || true
```
Expected: starts installer (will fail interactively, that's fine — we just verify no import errors)

- [ ] **Step 5: Commit**

```bash
git add src/clank.ts bin/clank.cjs
git commit -m "feat: migrate bin/clank.cjs to TypeScript ESM"
```

---

### Task 6: Migrate src/clank-tools.ts

**Files:**
- Create: `src/clank-tools.ts`
- Delete: `bin/clank-tools.cjs`

- [ ] **Step 1: Create `src/clank-tools.ts`**

```ts
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
```

- [ ] **Step 2: Delete old file**

```bash
rm bin/clank-tools.cjs
```

- [ ] **Step 3: Compile and verify**

```bash
npx tsc -p tsconfig.json
```
Expected: `dist/clank-tools.js` in `dist/`, zero errors

- [ ] **Step 4: Smoke test**

```bash
node dist/clank-tools.js help
```
Expected: help text printed

- [ ] **Step 5: Commit**

```bash
git add src/clank-tools.ts bin/clank-tools.cjs
git commit -m "feat: migrate bin/clank-tools.cjs to TypeScript ESM"
```

---

### Task 7: Migrate src/db.test.ts

**Files:**
- Create: `src/db.test.ts`
- Delete: `tests/db.test.cjs`

- [ ] **Step 1: Create `src/db.test.ts`**

```ts
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
```

- [ ] **Step 2: Delete old file**

```bash
rm tests/db.test.cjs
```

- [ ] **Step 3: Run just the db tests**

```bash
npx vitest run src/db.test.ts
```
Expected: 26 tests pass (pretest build runs first)

- [ ] **Step 4: Commit**

```bash
git add src/db.test.ts tests/db.test.cjs
git commit -m "test: migrate tests/db.test.cjs to TypeScript vitest"
```

---

### Task 8: Migrate src/clank-tools.test.ts

**Files:**
- Create: `src/clank-tools.test.ts`
- Delete: `tests/clank-tools.test.cjs`

- [ ] **Step 1: Create `src/clank-tools.test.ts`**

```ts
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
```

- [ ] **Step 2: Delete old file**

```bash
rm tests/clank-tools.test.cjs
```

- [ ] **Step 3: Run all tests**

```bash
npm test
```
Expected: all 65 tests pass (pretest rebuilds, vitest runs both test files)

- [ ] **Step 4: Commit**

```bash
git add src/clank-tools.test.ts tests/clank-tools.test.cjs
git commit -m "test: migrate tests/clank-tools.test.cjs to TypeScript vitest"
```

---

### Task 9: Full verification and cleanup

**Files:**
- Delete: `bin/` directory (now empty)
- Delete: `tests/` directory (now empty)

- [ ] **Step 1: Verify zero type errors**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no output, exit 0

- [ ] **Step 2: Run all tests**

```bash
npm test
```
Expected: 65 tests pass, 0 failures

- [ ] **Step 3: Run linter**

```bash
npx oxlint src
```
Expected: zero warnings or errors. Fix any that appear.

- [ ] **Step 4: Remove empty directories**

```bash
trash bin tests
```
Expected: both gone (all files were deleted in prior tasks)

- [ ] **Step 5: Verify no CJS source files remain**

```bash
find src -name "*.cjs" -o -name "*.js" | grep -v node_modules
```
Expected: no output

- [ ] **Step 6: Verify dist/ is gitignored**

```bash
grep "^dist/" .gitignore
```
Expected: `dist/`

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: remove empty bin/ and tests/ directories after TypeScript migration"
```
