# Clank Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Clank Claude Code plugin — a GSD-style plugin for test suite lifecycle management with four modes: audit, bootstrap, refactor, and watch.

**Architecture:** GSD-style plugin. A Node.js CLI tool (`bin/clank-tools.cjs`) handles all stateful operations (IDs, indexing, stack detection, scratch directories, config). All agent behavior lives in Markdown files (commands, workflows, agents, references). Subagents communicate through scratch JSON files, not the agent API.

**Tech Stack:** Node.js 22 CJS, `js-yaml` for frontmatter parsing, `node:test` + `node:assert` for unit tests, Markdown for all prompt files.

**Spec:** `docs/superpowers/specs/2026-03-20-clank-design.md` — read it before implementing any task.

---

## File Map

```
bin/
  clank-tools.cjs               # CLI tool — all stateful operations
  install.js                    # Plugin installer
tests/
  clank-tools.test.cjs          # Unit tests for clank-tools
.claude-plugin/
  plugin.json                   # Plugin metadata
package.json                    # Node project config + test script
commands/clank/
  audit.md                      # Entry point: /clank:audit
  bootstrap.md                  # Entry point: /clank:bootstrap
  refactor.md                   # Entry point: /clank:refactor
  watch.md                      # Entry point: /clank:watch
agents/
  clank-auditor.md              # Subagent: analyzes test coverage in a scope
  clank-bootstrapper.md         # Subagent: generates characterization tests for a file
  clank-refactorer.md           # Subagent: applies one structural refactor unit
  clank-watcher.md              # Subagent: detects drift for full project scope
clank/workflows/
  audit.md                      # Orchestrator: scope → spawn auditors → merge → report
  bootstrap.md                  # Orchestrator: scope → plan → approval → spawn bootstrappers
  refactor.md                   # Orchestrator: scope → plan → approval → sequential refactors
  watch.md                      # Orchestrator: baseline check → spawn watcher → report
clank/references/
  report-schema.md              # Canonical report format, status lifecycle, scratch protocol
  testing-philosophy.md         # Non-negotiable testing rules + test layers model
  anti-patterns.md              # Test smell catalog with detection signals
  behavior-preservation.md      # Inviolable contract for safe changes
  scope-resolution.md           # How agents ask for and resolve scope
  stack-detection.md            # Language/runner detection per path
clank/templates/
  audit-report.md               # Markdown template agents fill in for audit reports
  bootstrap-report.md           # Template for bootstrap reports
  refactor-report.md            # Template for refactor reports
  watch-report.md               # Template for watch reports
hooks/
  session-start                 # Loads recent reports; surfaces CodeGraph suggestion
```

---

## Phase 1: Foundation

### Task 1: Initialize project structure

**Files:**
- Create: `package.json`
- Create: `.claude-plugin/plugin.json`
- Create: `.gitignore`
- Create: `bin/` (directory)
- Create: `tests/` (directory)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "clank",
  "version": "0.1.0",
  "description": "Test suite lifecycle management plugin for Claude Code",
  "type": "commonjs",
  "scripts": {
    "test": "node --test tests/clank-tools.test.cjs"
  },
  "bin": {
    "clank-tools": "./bin/clank-tools.cjs"
  },
  "dependencies": {
    "js-yaml": "4.1.0"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

- [ ] **Step 2: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "clank",
  "description": "Test suite lifecycle management: audit, bootstrap, refactor, and watch for drift",
  "version": "0.1.0",
  "author": { "name": "Nick" },
  "license": "MIT",
  "keywords": ["testing", "tdd", "test-suite", "coverage", "quality"]
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.clank/scratch/
```

- [ ] **Step 4: Create directories**

```bash
mkdir -p bin tests commands/clank agents clank/workflows clank/references clank/templates hooks .claude-plugin
```

- [ ] **Step 5: Install dependencies**

```bash
npm install
```

Expected: `node_modules/js-yaml` exists.

- [ ] **Step 6: Commit**

```bash
git add package.json .claude-plugin/plugin.json .gitignore
git commit -m "chore: initialize Clank plugin project structure"
```

---

### Task 2: clank-tools — report-id command (TDD)

**Files:**
- Create: `tests/clank-tools.test.cjs`
- Create: `bin/clank-tools.cjs` (partial — report-id only)

- [ ] **Step 1: Write the failing tests for report-id**

Create `tests/clank-tools.test.cjs`:

```javascript
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
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
  return execSync(`node "${TOOL}" ${args.join(' ')}`, {
    encoding: 'utf8',
    env: { ...process.env, CLANK_PROJECT_ROOT: projectRoot },
  }).trim();
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | head -20
```

Expected: `Cannot find module` or similar error — `clank-tools.cjs` doesn't exist yet.

- [ ] **Step 3: Write minimal `bin/clank-tools.cjs` with report-id**

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = process.env.CLANK_PROJECT_ROOT || process.cwd();
const CLANK_DIR = path.join(PROJECT_ROOT, '.clank');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'clank_reports');

const [,, command, ...args] = process.argv;

const commands = { 'report-id': cmdReportId };

if (!command || !commands[command]) {
  process.stderr.write(`Unknown command: ${command}\nAvailable: ${Object.keys(commands).join(', ')}\n`);
  process.exit(1);
}
commands[command](...args);

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
```

- [ ] **Step 4: Run tests — verify report-id tests pass**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | grep -E "pass|fail|report-id"
```

Expected: all `report-id` tests pass.

- [ ] **Step 5: Commit**

```bash
git add bin/clank-tools.cjs tests/clank-tools.test.cjs
git commit -m "feat: add clank-tools report-id command with tests"
```

---

### Task 3: clank-tools — validate and recent commands (TDD)

**Files:**
- Modify: `tests/clank-tools.test.cjs` — add validate + recent tests
- Modify: `bin/clank-tools.cjs` — add validate + recent commands

- [ ] **Step 1: Write failing tests for validate**

Append to `tests/clank-tools.test.cjs`:

```javascript
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
```

- [ ] **Step 2: Run tests — verify new tests fail**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | grep -E "fail|Unknown command"
```

Expected: `validate` and `recent` tests fail with "Unknown command".

- [ ] **Step 3: Implement validate and recent in `bin/clank-tools.cjs`**

Add `js-yaml` require at the top, add `validate` and `recent` to the dispatch table, then add these functions:

```javascript
const yaml = require('js-yaml');

// add to commands object:
// 'validate': cmdValidate,
// 'recent': cmdRecent,

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
```

- [ ] **Step 4: Run all tests — verify they pass**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add bin/clank-tools.cjs tests/clank-tools.test.cjs
git commit -m "feat: add clank-tools validate and recent commands"
```

---

### Task 4: clank-tools — detect-stack command (TDD)

**Files:**
- Modify: `tests/clank-tools.test.cjs`
- Modify: `bin/clank-tools.cjs`

- [ ] **Step 1: Write failing tests for detect-stack**

Append to `tests/clank-tools.test.cjs`:

```javascript
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
```

- [ ] **Step 2: Run — verify detect-stack tests fail**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | grep "detect-stack"
```

Expected: all detect-stack tests fail.

- [ ] **Step 3: Implement detect-stack**

Add to dispatch table and add these functions to `bin/clank-tools.cjs`:

```javascript
// add to commands: 'detect-stack': cmdDetectStack

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
```

- [ ] **Step 4: Run all tests — verify they pass**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add bin/clank-tools.cjs tests/clank-tools.test.cjs
git commit -m "feat: add clank-tools detect-stack command"
```

---

### Task 5: clank-tools — codegraph commands (TDD)

**Files:**
- Modify: `tests/clank-tools.test.cjs`
- Modify: `bin/clank-tools.cjs`

- [ ] **Step 1: Write failing tests**

Append to `tests/clank-tools.test.cjs`:

```javascript
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
```

- [ ] **Step 2: Run — verify tests fail**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | grep "codegraph"
```

- [ ] **Step 3: Implement codegraph commands**

```javascript
const { execSync } = require('node:child_process');

// add to commands: 'codegraph-present': cmdCodegraphPresent, 'codegraph-fresh': cmdCodegraphFresh

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
    const out = execSync(`git -C "${PROJECT_ROOT}" log --since="${lastBuilt}" --oneline 2>/dev/null`, { encoding: 'utf8' });
    commitsSince = out.trim().split('\n').filter(Boolean).length;
  } catch (e) {
    // git unavailable or not a git repo — report as stale to be safe
    process.stdout.write(JSON.stringify({ fresh: false, last_built: lastBuilt, commits_since: -1, error: 'git unavailable' }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ fresh: commitsSince < 10, last_built: lastBuilt, commits_since: commitsSince }) + '\n');
}
```

- [ ] **Step 4: Run all tests**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add bin/clank-tools.cjs tests/clank-tools.test.cjs
git commit -m "feat: add clank-tools codegraph-present and codegraph-fresh"
```

---

### Task 6: clank-tools — scratch management (TDD)

**Files:**
- Modify: `tests/clank-tools.test.cjs`
- Modify: `bin/clank-tools.cjs`

- [ ] **Step 1: Write failing tests**

Append to `tests/clank-tools.test.cjs`:

```javascript
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
```

- [ ] **Step 2: Run — verify tests fail**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | grep "scratch"
```

- [ ] **Step 3: Implement scratch commands**

```javascript
// add to commands: 'scratch-init': cmdScratchInit, 'scratch-merge': cmdScratchMerge, 'scratch-clean': cmdScratchClean

function cmdScratchInit(runId) {
  if (!runId) { process.stderr.write('Usage: clank-tools scratch-init <run-id>\n'); process.exit(1); }
  const p = path.join(CLANK_DIR, 'scratch', runId);
  fs.mkdirSync(p, { recursive: true });
  process.stdout.write(p + '\n');
}

function cmdScratchMerge(runId) {
  if (!runId) { process.stderr.write('Usage: clank-tools scratch-merge <run-id>\n'); process.exit(1); }
  const scratchPath = path.join(CLANK_DIR, 'scratch', runId);
  if (!fs.existsSync(scratchPath)) { process.stdout.write(JSON.stringify({ findings: [], errors: [] }) + '\n'); return; }
  const findings = [], errors = [];
  for (const file of fs.readdirSync(scratchPath).filter(f => f.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(scratchPath, file), 'utf8'));
      if (d.status === 'complete' && Array.isArray(d.findings)) findings.push(...d.findings);
      else if (d.status === 'error') errors.push({ agent_index: d.agent_index, error: d.error });
    } catch (e) { errors.push({ file, error: e.message }); }
  }
  process.stdout.write(JSON.stringify({ findings, errors }) + '\n');
}

function cmdScratchClean(runId) {
  if (!runId) { process.stderr.write('Usage: clank-tools scratch-clean <run-id>\n'); process.exit(1); }
  const p = path.join(CLANK_DIR, 'scratch', runId);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
}
```

- [ ] **Step 4: Run all tests**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add bin/clank-tools.cjs tests/clank-tools.test.cjs
git commit -m "feat: add clank-tools scratch management commands"
```

---

### Task 7: clank-tools — config commands (TDD)

**Files:**
- Modify: `tests/clank-tools.test.cjs`
- Modify: `bin/clank-tools.cjs`

- [ ] **Step 1: Write failing tests**

Append to `tests/clank-tools.test.cjs`:

```javascript
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
```

- [ ] **Step 2: Run — verify tests fail**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | grep "config"
```

- [ ] **Step 3: Implement config commands**

```javascript
// add to commands: 'config-get': cmdConfigGet, 'config-set': cmdConfigSet

function readConfig() {
  const p = path.join(CLANK_DIR, 'config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeConfig(cfg) {
  fs.mkdirSync(CLANK_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLANK_DIR, 'config.json'), JSON.stringify(cfg, null, 2));
}

function cmdConfigGet(key) {
  if (!key) { process.stderr.write('Usage: clank-tools config-get <key>\n'); process.exit(1); }
  const cfg = readConfig();
  process.stdout.write(JSON.stringify(cfg[key] ?? null) + '\n');
}

function cmdConfigSet(key, value) {
  if (!key || value === undefined) { process.stderr.write('Usage: clank-tools config-set <key> <value>\n'); process.exit(1); }
  const cfg = readConfig();
  try { cfg[key] = JSON.parse(value); } catch { cfg[key] = value; }
  writeConfig(cfg);
}
```

- [ ] **Step 4: Run entire test suite — all green**

```bash
node --test tests/clank-tools.test.cjs 2>&1 | tail -5
```

Expected: all tests pass, zero failures.

- [ ] **Step 5: Commit**

```bash
git add bin/clank-tools.cjs tests/clank-tools.test.cjs
git commit -m "feat: add clank-tools config-get and config-set commands"
```

---

### Task 8: clank-tools — CLI help, installer scaffold, and shebang

**Files:**
- Modify: `bin/clank-tools.cjs`
- Create: `bin/install.js` (stub)

- [ ] **Step 1: Add help output and shebang to clank-tools.cjs**

Ensure the first line of `bin/clank-tools.cjs` is `#!/usr/bin/env node` and add a `help` command:

```javascript
// add to commands: 'help': cmdHelp

function cmdHelp() {
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
  help                         Show this help
`);
}
```

- [ ] **Step 2: Make clank-tools.cjs executable**

```bash
chmod +x bin/clank-tools.cjs
```

- [ ] **Step 3: Write stub `bin/install.js`**

```javascript
#!/usr/bin/env node
'use strict';
// Fully implemented in Task 29
console.log('Clank installer — not yet implemented');
```

- [ ] **Step 4: Run help**

```bash
node bin/clank-tools.cjs help
```

Expected: command list printed.

- [ ] **Step 5: Run full test suite one final time**

```bash
node --test tests/clank-tools.test.cjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add bin/clank-tools.cjs bin/install.js
git commit -m "feat: add help command and install stub to clank-tools"
```

---

## Phase 2: Reference Library

> Reference docs are consumed by every agent. They must be precise, actionable, and free of ambiguity. Read the spec before writing each one.

### Task 9: report-schema.md

**Files:**
- Create: `clank/references/report-schema.md`

- [ ] **Step 1: Write `clank/references/report-schema.md`**

Must include:
- The canonical YAML frontmatter block with all required fields: `id`, `mode`, `scope` (inline JSON string), `stack`, `codegraph_confidence`, `created_at`, `status`, `based_on`
- The scope JSON object schema: `{ type: "file|directory|function|project", paths: string[], symbols: string[] }`
- The status lifecycle: `awaiting_approval → in_progress → complete | partial` and `corrupt` as a read-only sentinel
- The scratch file format: `{ agent_index, scope, status: "complete|error", findings: [], error: null }`
- The `findings` array item schema for each mode (audit findings: `{ type, file, symbol?, description, severity: "blocking|advisory" }`)
- The `clank-tools recent` JSON output schema
- The section structure all report templates must follow: Scope, Findings, Metrics, Recommended Actions, Raw Data
- The `codegraph_confidence` values: `high` (CodeGraph present and fresh), `low` (Grep/Glob fallback), `stale` (CodeGraph present but outdated)
- Note: `scope` is stored as an inline JSON string on one line in YAML to avoid multi-line parsing complexity

- [ ] **Step 2: Verify file exists and contains required sections**

```bash
grep -c "awaiting_approval\|scratch\|findings\|codegraph_confidence" clank/references/report-schema.md
```

Expected: 4 or more matches.

- [ ] **Step 3: Commit**

```bash
git add clank/references/report-schema.md
git commit -m "docs: add report-schema reference"
```

---

### Task 10: testing-philosophy.md

**Files:**
- Create: `clank/references/testing-philosophy.md`

- [ ] **Step 1: Write `clank/references/testing-philosophy.md`**

Must include:
- **Test Layers Model** section: define unit, integration, and end-to-end tests; state that mocking advice depends on layer classification; never evaluate mocking without first classifying the test
- **Philosophy Rules table** with `severity` column (blocking/advisory) and source attribution for each rule — all 12 rules from the spec's Testing Philosophy section
- **Detection mechanisms** for "a test that can't fail": assertions inside catch-all blocks, `expect(x).toBe(x)`, empty test bodies, assertions on a mock's own return value
- **Blocking violation behavior**: a report with any blocking violation must not be marked `status: complete`; violations are listed in the Findings section with `severity: blocking`
- **Advisory violation behavior**: listed in Findings with `severity: advisory`; do not block completion
- Citation block listing all source books with full titles and authors

- [ ] **Step 2: Verify**

```bash
grep -c "blocking\|advisory\|unit\|integration\|end-to-end" clank/references/testing-philosophy.md
```

Expected: 5+ matches.

- [ ] **Step 3: Commit**

```bash
git add clank/references/testing-philosophy.md
git commit -m "docs: add testing-philosophy reference"
```

---

### Task 11: anti-patterns.md

**Files:**
- Create: `clank/references/anti-patterns.md`

- [ ] **Step 1: Write `clank/references/anti-patterns.md`**

For each anti-pattern, include: name, description, detection signal (concrete code pattern to look for), and severity. Must include all patterns from the spec:
- Testing implementation details
- Logic in tests
- Multiple concepts per test
- Tests that always pass (no assertion, wrong exception caught)
- Tautological assertions (`expect(x).toBe(x)`)
- Assertion roulette (multiple bare asserts, no failure message)
- Unclear test names
- Excessive mocking (note: evaluate per test layer)
- **Flaky tests** — with detection signals: `time.sleep`/`asyncio.sleep`, unordered collection iteration, unseeded `Date.now()`/`Math.random()`, raw network calls, async race patterns
- Fixture data without seeding
- Order-dependent tests
- Dead tests
- Giant setup blocks
- Characterization tests without `characterizes_` naming convention

- [ ] **Step 2: Verify flaky test section exists**

```bash
grep -c "flak\|sleep\|random\|Date.now" clank/references/anti-patterns.md
```

Expected: 3+ matches.

- [ ] **Step 3: Commit**

```bash
git add clank/references/anti-patterns.md
git commit -m "docs: add anti-patterns reference"
```

---

### Task 12: behavior-preservation.md

**Files:**
- Create: `clank/references/behavior-preservation.md`

- [ ] **Step 1: Write `clank/references/behavior-preservation.md`**

Must include:
- All 6 rules from the spec verbatim, numbered
- **Definition of "broken baseline"**: non-zero exit code or compilation failure; skipped/xfail tests do not block
- **Rule 3 clarification**: always run the **full suite**, not a subset — scope determination is unreliable; explicitly forbid running only "affected tests"
- **Bootstrap additive-only clarification**: subagents may read existing test helpers to avoid fixture duplication; they must not write to existing test files
- **What to do on regression**: revert the unit immediately using `git restore`; mark unit as `reverted` in journal; log in report; continue to next unit
- **What to do on broken baseline**: stop entirely; write a report with `status: blocked`; do not proceed with any changes

- [ ] **Step 2: Verify**

```bash
grep -c "full suite\|git restore\|blocked\|additive" clank/references/behavior-preservation.md
```

Expected: 4+ matches.

- [ ] **Step 3: Commit**

```bash
git add clank/references/behavior-preservation.md
git commit -m "docs: add behavior-preservation reference"
```

---

### Task 13: scope-resolution.md

**Files:**
- Create: `clank/references/scope-resolution.md`

- [ ] **Step 1: Write `clank/references/scope-resolution.md`**

Must include:
- The exact questions each mode should ask (audit, bootstrap, refactor, watch each have different scope framing)
- The scope object JSON schema: `{ type, paths[], symbols[] }`
- How to resolve "full project" → `{ type: "project", paths: ["."], symbols: [] }`
- How to resolve a directory → `{ type: "directory", paths: ["src/api/"], symbols: [] }`
- How to resolve a file → `{ type: "file", paths: ["src/utils/parser.ts"], symbols: [] }`
- How to resolve a function → `{ type: "function", paths: ["src/utils/parser.ts"], symbols: ["parseDate"] }`
- How to run `clank-tools detect-stack <path>` on each resolved path
- How the scope object is stored in report frontmatter as an inline JSON string
- Instruction: if user gives ambiguous answer, ask a clarifying follow-up before proceeding

- [ ] **Step 2: Verify**

```bash
grep -c "type.*project\|type.*directory\|type.*file\|type.*function" clank/references/scope-resolution.md
```

Expected: 4 matches.

- [ ] **Step 3: Commit**

```bash
git add clank/references/scope-resolution.md
git commit -m "docs: add scope-resolution reference"
```

---

### Task 14: stack-detection.md

**Files:**
- Create: `clank/references/stack-detection.md`

- [ ] **Step 1: Write `clank/references/stack-detection.md`**

Must include:
- Instruction: always run `clank-tools detect-stack <path>` rather than inferring stack manually
- What to do with the JSON output: extract `language`, `test_runner`, `manifest_path`
- **Monorepo rule**: run `detect-stack` on each path in `scope.paths` separately; if paths return different stacks, treat each stack independently in the report
- **Conflict rule**: if `detect-stack` returns `language: unknown` and the scope is non-trivial, ask the user which language and test runner to use
- The idiomatic test command per runner: vitest → `npx vitest run`, jest → `npx jest`, pytest → `pytest`, cargo → `cargo test`, go → `go test ./...`, exunit → `mix test`
- Note: `detect-stack` reads `devDependencies` from `package.json` — a project with both typescript and vitest in devDeps reports `typescript/vitest`

- [ ] **Step 2: Verify**

```bash
grep -c "detect-stack\|monorepo\|idiomatic\|conflict" clank/references/stack-detection.md
```

Expected: 3+ matches.

- [ ] **Step 3: Commit**

```bash
git add clank/references/stack-detection.md
git commit -m "docs: add stack-detection reference"
```

---

## Phase 3: Report Templates

### Task 15: Report templates (all four)

**Files:**
- Create: `clank/templates/audit-report.md`
- Create: `clank/templates/bootstrap-report.md`
- Create: `clank/templates/refactor-report.md`
- Create: `clank/templates/watch-report.md`

- [ ] **Step 1: Write `clank/templates/audit-report.md`**

```markdown
---
id: {{ID}}
mode: audit
scope: {{SCOPE_JSON}}
stack: {{STACK}}
codegraph_confidence: {{CODEGRAPH_CONFIDENCE}}
created_at: {{CREATED_AT}}
status: complete
based_on: null
---

# Clank Audit Report

## Scope
{{SCOPE_DESCRIPTION}}

## Findings

### Coverage Gaps
<!-- List of untested files/functions with severity -->

### Anti-Patterns
<!-- List of detected test smells with file:line and severity -->

### Redundancy
<!-- Duplicate coverage or dead tests -->

## Metrics
- Files analyzed: {{FILES_ANALYZED}}
- Functions covered: {{COVERED}}/{{TOTAL}} ({{PCT}}%)
- Blocking violations: {{BLOCKING_COUNT}}
- Advisory violations: {{ADVISORY_COUNT}}

## Recommended Actions
<!-- Numbered, prioritized list -->

## Raw Data
```json
{
  "findings": []
}
```
```

- [ ] **Step 2: Write `clank/templates/bootstrap-report.md`**

Include: same frontmatter structure with `status: awaiting_approval`; sections: Scope, Planned Tests (one entry per function to be covered with proposed test name and behavior description), Characterization Notes (any suspected defects found), Functions Requiring Manual Characterization, Metrics, Raw Data.

- [ ] **Step 3: Write `clank/templates/refactor-report.md`**

Include: same frontmatter with `status: awaiting_approval`; sections: Scope, Baseline Results (test count, pass/fail before changes), Planned Changes (one entry per unit: file, description, type of change), Execution Log (filled in during run: unit status done/reverted with reason), Metrics, Raw Data. Journal path field in frontmatter.

- [ ] **Step 4: Write `clank/templates/watch-report.md`**

Include: frontmatter with `based_on: {{BASELINE_AUDIT_ID}}`; sections: Scope, Baseline, Drift Detected (new files without tests, signature changes, deleted test symbols), Priority Actions (numbered), Metrics (files drifted, functions drifted), Raw Data.

- [ ] **Step 5: Verify all four templates exist**

```bash
ls clank/templates/
```

Expected: 4 files.

- [ ] **Step 6: Commit**

```bash
git add clank/templates/
git commit -m "docs: add report templates for all four modes"
```

---

## Phase 4: Audit Mode

### Task 16: clank-auditor agent

**Files:**
- Create: `agents/clank-auditor.md`

- [ ] **Step 1: Write `agents/clank-auditor.md`**

YAML frontmatter:
```yaml
---
name: clank-auditor
description: >
  Analyzes test coverage for a specific scope (file, directory, or function).
  Spawned by the audit orchestrator. Writes findings to a scratch JSON file.
  Never modifies production code or test files.
tools: Read, Bash, Grep, Glob, mcp__codegraph__codegraph_search,
  mcp__codegraph__codegraph_callers, mcp__codegraph__codegraph_node,
  mcp__codegraph__codegraph_impact
color: cyan
---
```

Body must include:
- **Role**: analyze the assigned scope for coverage gaps and test anti-patterns; write results to the assigned scratch file; never touch source or test files
- **Required reading before acting**: `~/.claude/clank/references/testing-philosophy.md`, `~/.claude/clank/references/anti-patterns.md`, `~/.claude/clank/references/stack-detection.md`, `~/.claude/clank/references/report-schema.md`
- **Input**: the orchestrator passes `run_id`, `agent_index`, `scope` object, `scratch_path` in the prompt
- **CodeGraph-first**: if `.codegraph/` exists and is fresh (check with `clank-tools codegraph-fresh`), use `codegraph_search` and `codegraph_callers` to map coverage; fall back to Grep/Glob and tag findings as `confidence: low`
- **Coverage gap detection**: for each public function/method in scope, check whether a test file calls it; a function has no test if no test file imports or calls it by name
- **Anti-pattern detection**: read each test file in scope; check for patterns from anti-patterns.md; record each violation with file path, line number, pattern name, severity
- **Scratch output**: write to `{scratch_path}/{agent_index}.json` with the schema from report-schema.md; `status: complete` on success, `status: error` with `error` message on failure

- [ ] **Step 2: Verify agent has required sections**

```bash
grep -c "Required reading\|scratch\|CodeGraph-first\|anti-pattern" agents/clank-auditor.md
```

Expected: 4 matches.

- [ ] **Step 3: Commit**

```bash
git add agents/clank-auditor.md
git commit -m "feat: add clank-auditor agent"
```

---

### Task 17: audit workflow

**Files:**
- Create: `clank/workflows/audit.md`

- [ ] **Step 1: Write `clank/workflows/audit.md`**

Must include these sections in order:

**Role**: orchestrator for audit mode; never reads source or test files directly; delegates all analysis to `clank-auditor` subagents; assembles and writes the final report.

**Required reading**: `~/.claude/clank/references/scope-resolution.md`, `~/.claude/clank/references/report-schema.md`, `~/.claude/clank/references/stack-detection.md`

**Step 1 — Scope resolution**: follow scope-resolution.md to ask the user what to audit; resolve to a scope object; run `node ~/.claude/clank/bin/clank-tools.cjs detect-stack <path>` for each path in scope

**Step 2 — Initialize run**:
```bash
RUN_ID=$(node ~/.claude/clank/bin/clank-tools.cjs report-id audit)
SCRATCH=$(node ~/.claude/clank/bin/clank-tools.cjs scratch-init $RUN_ID)
```

**Step 3 — Check CodeGraph**:
```bash
node ~/.claude/clank/bin/clank-tools.cjs codegraph-fresh
```
Set `codegraph_confidence` from result.

**Step 4 — Spawn subagents**: for each module/directory in scope, spawn a `clank-auditor` subagent with: `run_id`, `agent_index`, `scope` (the sub-scope for this module), `scratch_path: SCRATCH`. Run in parallel.

**Step 5 — Merge results**:
```bash
node ~/.claude/clank/bin/clank-tools.cjs scratch-merge $RUN_ID
```

**Step 6 — Write report**: read `~/.claude/clank/templates/audit-report.md`; fill in all `{{PLACEHOLDER}}` values; write to `clank_reports/${RUN_ID}.md`; set `status: complete` unless any agent had errors (then `status: partial`)

**Step 7 — Cleanup**:
```bash
node ~/.claude/clank/bin/clank-tools.cjs scratch-clean $RUN_ID
node ~/.claude/clank/bin/clank-tools.cjs config-set last_audit '"'$RUN_ID'"'
```

**Step 8 — Present report**: summarize findings to user; give path to full report.

- [ ] **Step 2: Verify workflow has all 8 steps**

```bash
grep -c "Step [0-9]" clank/workflows/audit.md
```

Expected: 8.

- [ ] **Step 3: Commit**

```bash
git add clank/workflows/audit.md
git commit -m "feat: add audit workflow"
```

---

### Task 18: audit command entry point

**Files:**
- Create: `commands/clank/audit.md`

- [ ] **Step 1: Write `commands/clank/audit.md`**

```markdown
# /clank:audit

Audit your test suite for coverage gaps, anti-patterns, and quality issues.

Produces a full findings report in `clank_reports/` before touching any files.

Follow the workflow at: ~/.claude/clank/workflows/audit.md
```

- [ ] **Step 2: Commit**

```bash
git add commands/clank/audit.md
git commit -m "feat: add /clank:audit command entry point"
```

---

## Phase 5: Bootstrap Mode

### Task 19: clank-bootstrapper agent

**Files:**
- Create: `agents/clank-bootstrapper.md`

- [ ] **Step 1: Write `agents/clank-bootstrapper.md`**

YAML frontmatter: same pattern as clank-auditor with name `clank-bootstrapper`, description covering characterization test generation, tools including Read, Write, Bash, Grep, Glob, codegraph tools.

Body must include:
- **Role**: generate characterization tests for one assigned file; write tests to a new test file; never modify existing test files; may read existing test helpers to avoid fixture duplication
- **Required reading**: testing-philosophy.md, anti-patterns.md, behavior-preservation.md, stack-detection.md, report-schema.md
- **Input**: `run_id`, `agent_index`, `scratch_path`, `target_file` (the production file to characterize), `stack` object, `test_file_path` (where to write the new test file)
- **Inference algorithm**: read `target_file`; for each exported function/method: (1) read the implementation; (2) identify: return type, input types, branches, error paths; (3) if behavior cannot be inferred without running the code, skip and record in scratch under `requires_manual`; (4) otherwise, write one test per behavior
- **Characterization contract**: all test names must start with `characterizes ` / `characterizes_`; if a suspected defect is found, generate the test capturing current behavior AND add a comment `# CHARACTERIZATION: this test captures current behavior which may be incorrect — {reason}`; record suspected defects in scratch under `suspected_defects`
- **Test quality**: follow testing-philosophy.md; each test must follow AAA; no logic in tests; one concept per test
- **Scratch output**: write `{ agent_index, status, findings: [{ file, tests_written, requires_manual, suspected_defects }], error }` to `{scratch_path}/{agent_index}.json`

- [ ] **Step 2: Verify agent has characterization contract section**

```bash
grep -c "characterizes\|suspected_defect\|inference\|requires_manual" agents/clank-bootstrapper.md
```

Expected: 4+ matches.

- [ ] **Step 3: Commit**

```bash
git add agents/clank-bootstrapper.md
git commit -m "feat: add clank-bootstrapper agent"
```

---

### Task 20: bootstrap workflow

**Files:**
- Create: `clank/workflows/bootstrap.md`

- [ ] **Step 1: Write `clank/workflows/bootstrap.md`**

Steps:
1. **Scope + intent**: ask what to cover and how (full public API, happy paths, edge cases)
2. **Initialize run**: `clank-tools report-id bootstrap` + `scratch-init`
3. **Analysis phase**: for each file in scope, spawn `clank-auditor` subagents to discover untested functions; merge results
4. **Plan report**: write `clank_reports/${RUN_ID}.md` using bootstrap-report.md template with `status: awaiting_approval`; list every planned test with function name, proposed test name, behavior description; list `requires_manual` items; list `suspected_defects`
5. **Approval gate**: present summary to user; ask "Approve this plan?"; update report `status: in_progress` on approval; stop if declined
6. **Bootstrap phase**: for each file, compute `test_file_path` following project conventions (colocated `*.test.ts` or `tests/` mirror); spawn `clank-bootstrapper` subagent per file in parallel
7. **Merge + finalize**: merge scratch results; update report with actual tests written, any `requires_manual` or `suspected_defects` from subagents; set `status: complete`; run `config-set last_bootstrap`; cleanup scratch
8. **Present results**: summarize tests generated; highlight suspected defects; list items requiring manual characterization

- [ ] **Step 2: Verify approval gate is present**

```bash
grep -c "awaiting_approval\|Approve\|approval" clank/workflows/bootstrap.md
```

Expected: 3+ matches.

- [ ] **Step 3: Commit**

```bash
git add clank/workflows/bootstrap.md
git commit -m "feat: add bootstrap workflow"
```

---

### Task 21: bootstrap command entry point

**Files:**
- Create: `commands/clank/bootstrap.md`

- [ ] **Step 1: Write `commands/clank/bootstrap.md`**

```markdown
# /clank:bootstrap

Generate characterization tests for untested or undertested code.

Produces a test plan report and waits for your approval before writing any files.
All generated tests follow the characterization contract — they describe what the
code currently does, not what it should do.

Follow the workflow at: ~/.claude/clank/workflows/bootstrap.md
```

- [ ] **Step 2: Commit**

```bash
git add commands/clank/bootstrap.md
git commit -m "feat: add /clank:bootstrap command entry point"
```

---

## Phase 6: Refactor Mode

### Task 22: clank-refactorer agent

**Files:**
- Create: `agents/clank-refactorer.md`

- [ ] **Step 1: Write `agents/clank-refactorer.md`**

YAML frontmatter: name `clank-refactorer`, tools: Read, Write, Edit, Bash, Grep, Glob.

Body must include:
- **Role**: execute one structural refactor unit; run the full suite before and after; revert immediately on regression; update the journal
- **Required reading**: behavior-preservation.md, testing-philosophy.md, report-schema.md
- **Input**: `journal_path`, `unit_index`, `unit` (the unit object from the journal: `{ file, description, status }`), `test_run_command`
- **Execution**:
  1. Read behavior-preservation.md
  2. Run `{test_run_command}` — if non-zero exit: write error to scratch and stop
  3. Apply the structural change (the `unit.description` defines exactly what to do)
  4. Run `{test_run_command}` again
  5. If exit code changed from 0 to non-zero: `git restore {file}`; mark unit `reverted`; write reason to scratch
  6. If exit code 0: mark unit `done`
  7. Update `journal_path` with new unit status
- **Scratch output**: `{ agent_index: unit_index, status: "complete", findings: [{ unit_index, file, status: "done|reverted", reason? }], error: null }`
- **Refactor scope allowed**: deduplication, rename for clarity, fixture extraction, domain reorganization, parameterization with `test.each`/`@pytest.mark.parametrize`
- **Explicitly forbidden**: changing what is being tested, adding or removing assertions, modifying production code

- [ ] **Step 2: Verify revert logic is present**

```bash
grep -c "git restore\|revert\|forbidden\|full suite" agents/clank-refactorer.md
```

Expected: 4+ matches.

- [ ] **Step 3: Commit**

```bash
git add agents/clank-refactorer.md
git commit -m "feat: add clank-refactorer agent"
```

---

### Task 23: refactor workflow

**Files:**
- Create: `clank/workflows/refactor.md`

- [ ] **Step 1: Write `clank/workflows/refactor.md`**

Steps:
1. **Scope + intent**: ask what to refactor and what kind of improvements are wanted
2. **Initialize**: `clank-tools report-id refactor` + `scratch-init`
3. **Baseline check**: run `{test_run_command}`; if non-zero exit or compilation failure, write report with `status: blocked` and stop; never proceed from broken baseline
4. **Plan units**: analyze scope (using clank-auditor subagents or directly for small scope); produce list of units — each unit has `{ file, description, type: "deduplicate|rename|extract-fixture|reorganize|parameterize" }`
5. **Plan report**: write report using refactor-report.md template with `status: awaiting_approval`; create `.clank/journals/refactor-${RUN_ID}.json` with all units as `pending`
6. **Approval gate**: present summary; ask "Approve this plan?"; update report to `in_progress` on approval
7. **Sequential execution**: for each pending unit in journal, spawn one `clank-refactorer` subagent; wait for completion before starting next; update journal after each
8. **Finalize**: merge results; if any units `reverted`, set `status: partial`; else `status: complete`; write final report; `config-set last_refactor`; cleanup scratch
9. **Present results**: show units completed, units reverted with reasons; give path to report and journal

- [ ] **Step 2: Verify sequential execution and broken baseline handling**

```bash
grep -c "Sequential\|sequential\|blocked\|one.*at a time\|journal" clank/workflows/refactor.md
```

Expected: 3+ matches.

- [ ] **Step 3: Commit**

```bash
git add clank/workflows/refactor.md
git commit -m "feat: add refactor workflow"
```

---

### Task 24: refactor command entry point

**Files:**
- Create: `commands/clank/refactor.md`

- [ ] **Step 1: Write `commands/clank/refactor.md`**

```markdown
# /clank:refactor

Refactor the structure of your test suite without changing what is being tested.

Produces a plan report and waits for your approval. Changes are applied one unit
at a time with a full suite run after each. Any regression is immediately reverted.

Requires a clean test baseline to start. Will not proceed from a broken suite.

Follow the workflow at: ~/.claude/clank/workflows/refactor.md
```

- [ ] **Step 2: Commit**

```bash
git add commands/clank/refactor.md
git commit -m "feat: add /clank:refactor command entry point"
```

---

## Phase 7: Watch Mode

### Task 25: clank-watcher agent

**Files:**
- Create: `agents/clank-watcher.md`

- [ ] **Step 1: Write `agents/clank-watcher.md`**

YAML frontmatter: name `clank-watcher`, tools: Read, Bash, Grep, Glob, codegraph tools.

Body must include:
- **Role**: detect drift between production code and the test suite; never make changes; write results to scratch
- **Required reading**: report-schema.md, stack-detection.md, scope-resolution.md
- **Input**: `run_id`, `agent_index`, `scratch_path`, `scope`, `baseline_report_path` (path to prior audit report or null)
- **Drift detection algorithm**:
  1. Build a map of production symbols from scope (use CodeGraph if fresh, else Grep)
  2. Build a map of what is currently tested (which symbols appear in test files)
  3. If `baseline_report_path` provided: load `Raw Data.findings` from prior report to compare against current state
  4. New production files with no corresponding test file → drift type `new_file`
  5. Functions whose signature/control flow changed since baseline (use `git diff --stat` + re-read symbol) → drift type `signature_change`
  6. Test symbols that reference deleted or renamed production symbols → drift type `dead_reference`
  7. **Cosmetic changes (whitespace, comments, docstrings only) do not create drift alerts**
- **Scratch output**: `{ agent_index, status, findings: [{ drift_type, file, symbol?, description, priority: "high|medium|low" }], error }`

- [ ] **Step 2: Verify drift types and cosmetic exclusion**

```bash
grep -c "new_file\|signature_change\|dead_reference\|cosmetic\|whitespace" agents/clank-watcher.md
```

Expected: 4+ matches.

- [ ] **Step 3: Commit**

```bash
git add agents/clank-watcher.md
git commit -m "feat: add clank-watcher agent"
```

---

### Task 26: watch workflow

**Files:**
- Create: `clank/workflows/watch.md`

- [ ] **Step 1: Write `clank/workflows/watch.md`**

Steps:
1. **Scope**: ask what to watch (default: full project)
2. **Baseline check**: run `clank-tools recent 5`; find most recent audit report whose scope covers the current watch scope; if none found or scope is narrower, run a lightweight inline audit first: single `clank-auditor` subagent, full project scope, no parallelism — use that report as baseline; note in watch report `based_on: {inline-audit-id}`
3. **Initialize**: `clank-tools report-id watch` + `scratch-init`
4. **Spawn watcher**: single `clank-watcher` subagent with scope, scratch path, and baseline report path
5. **Write report**: using watch-report.md template; fill `based_on` with baseline report ID; set `status: complete`; `config-set last_watch`; cleanup scratch
6. **Present**: list drift items by priority; note if no drift found ("Suite is in sync")

- [ ] **Step 2: Verify baseline fallback logic**

```bash
grep -c "inline audit\|narrower\|based_on\|no drift\|in sync" clank/workflows/watch.md
```

Expected: 3+ matches.

- [ ] **Step 3: Commit**

```bash
git add clank/workflows/watch.md
git commit -m "feat: add watch workflow"
```

---

### Task 27: watch command entry point

**Files:**
- Create: `commands/clank/watch.md`

- [ ] **Step 1: Write `commands/clank/watch.md`**

```markdown
# /clank:watch

Detect drift between your production code and test suite.

Compares current state against the most recent audit report as baseline.
If no prior audit exists, runs a lightweight inline audit first.

Reports: new files without tests, changed function signatures, dead test references.
Never makes changes — surfaces what needs attention.

Follow the workflow at: ~/.claude/clank/workflows/watch.md
```

- [ ] **Step 2: Commit**

```bash
git add commands/clank/watch.md
git commit -m "feat: add /clank:watch command entry point"
```

---

## Phase 8: Integration

### Task 28: session-start hook

**Files:**
- Create: `hooks/session-start`

- [ ] **Step 1: Write `hooks/session-start`**

This is a shell script executed by Claude Code on session start. It should output context for Claude to read.

```bash
#!/bin/bash
set -euo pipefail

CLANK_TOOLS="$HOME/.claude/clank/bin/clank-tools.cjs"

# Only run if clank-tools exists and we're in a project
if [[ ! -f "$CLANK_TOOLS" ]]; then exit 0; fi
if [[ ! -d ".clank" ]] && [[ ! -d "clank_reports" ]]; then exit 0; fi

# Load recent reports summary
RECENT=$(node "$CLANK_TOOLS" recent 3 2>/dev/null || echo "[]")
if [[ "$RECENT" != "[]" ]]; then
  echo "## Clank: Recent Reports"
  echo "$RECENT" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    d.forEach(r => console.log(\`- [\${r.mode}] \${r.id} — \${r.status} — \${r.created_at.slice(0,10)}\`));
  " 2>/dev/null || true
  echo ""
fi

# CodeGraph suggestion (shown once)
CG_SHOWN=$(node "$CLANK_TOOLS" config-get codegraph_suggestion_shown 2>/dev/null || echo "null")
CG_PRESENT=$(node "$CLANK_TOOLS" codegraph-present 2>/dev/null || echo "false")

if [[ "$CG_SHOWN" != "true" ]] && [[ "$CG_PRESENT" == "false" ]]; then
  echo "## Clank: CodeGraph Not Initialized"
  echo "Running \`codegraph init -i\` would let Clank navigate your codebase more accurately"
  echo "and use significantly fewer tokens. Consider running it before your first /clank:audit."
  node "$CLANK_TOOLS" config-set codegraph_suggestion_shown true 2>/dev/null || true
fi
```

- [ ] **Step 2: Make executable**

```bash
chmod +x hooks/session-start
```

- [ ] **Step 3: Verify script passes shellcheck**

```bash
shellcheck hooks/session-start
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add hooks/session-start
git commit -m "feat: add session-start hook for report summary and CodeGraph suggestion"
```

---

### Task 29: Plugin installer

**Files:**
- Modify: `bin/install.js`

- [ ] **Step 1: Implement `bin/install.js`**

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECT_ROOT = process.env.CLANK_INSTALL_PROJECT || process.cwd();
const CLAUDE_LOCAL = path.join(PROJECT_ROOT, '.claude');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readSettings(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeSettings(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

console.log('Installing Clank...');

// 1. Copy commands
copyDir(path.join(PLUGIN_ROOT, 'commands', 'clank'), path.join(CLAUDE_LOCAL, 'commands', 'clank'));
console.log('✓ commands/clank/');

// 2. Copy agents
copyDir(path.join(PLUGIN_ROOT, 'agents'), path.join(CLAUDE_LOCAL, 'agents'));
console.log('✓ agents/');

// 3. Copy clank/ references, workflows, templates globally
copyDir(path.join(PLUGIN_ROOT, 'clank'), path.join(CLAUDE_DIR, 'clank'));
console.log('✓ ~/.claude/clank/');

// 4. Copy bin/ globally
copyDir(path.join(PLUGIN_ROOT, 'bin'), path.join(CLAUDE_DIR, 'clank', 'bin'));
console.log('✓ ~/.claude/clank/bin/');

// 5. Register session-start hook
const settingsPath = path.join(CLAUDE_LOCAL, 'settings.json');
const settings = readSettings(settingsPath);
settings.hooks = settings.hooks || {};
settings.hooks['session-start'] = settings.hooks['session-start'] || [];
const hookCmd = `${path.join(CLAUDE_DIR, 'clank', 'hooks', 'session-start')}`;
if (!settings.hooks['session-start'].includes(hookCmd)) {
  settings.hooks['session-start'].push(hookCmd);
}
writeSettings(settingsPath, settings);
console.log('✓ session-start hook registered');

// 6. Copy hook
const hooksDir = path.join(CLAUDE_DIR, 'clank', 'hooks');
fs.mkdirSync(hooksDir, { recursive: true });
fs.copyFileSync(path.join(PLUGIN_ROOT, 'hooks', 'session-start'), path.join(hooksDir, 'session-start'));
fs.chmodSync(path.join(hooksDir, 'session-start'), 0o755);

// 7. Create .clank/ in project
fs.mkdirSync(path.join(PROJECT_ROOT, '.clank', 'journals'), { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT, '.clank', 'scratch'), { recursive: true });
if (!fs.existsSync(path.join(PROJECT_ROOT, '.clank', 'config.json'))) {
  fs.writeFileSync(path.join(PROJECT_ROOT, '.clank', 'config.json'), JSON.stringify({
    codegraph_suggestion_shown: false,
    last_audit: null, last_bootstrap: null, last_refactor: null, last_watch: null,
    test_run_command: null
  }, null, 2));
}
console.log('✓ .clank/ initialized in project');

console.log('\nClank installed. Run /clank:audit to get started.');
```

- [ ] **Step 2: Make executable**

```bash
chmod +x bin/install.js
```

- [ ] **Step 3: Dry-run install to temp location**

```bash
CLANK_INSTALL_PROJECT=/tmp/clank-install-test node bin/install.js
ls /tmp/clank-install-test/.clank/
```

Expected: `config.json`, `journals/`, `scratch/` exist.

- [ ] **Step 4: Commit**

```bash
git add bin/install.js
git commit -m "feat: implement Clank installer"
```

---

### Task 30: README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

Must cover:
- What Clank is (one paragraph)
- Installation: `npx clank install` or `node bin/install.js`
- The four commands with one-line descriptions
- Report history: where reports live, what they contain
- CodeGraph integration: why it matters, how to initialize
- The testing philosophy: brief statement that Clank enforces rules from Beck, Feathers, Freeman & Pryce, Osherove, Meszaros, Martin
- Behavior-preservation guarantee: what it means for refactor and bootstrap
- Contributing: pointer to spec doc

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

### Task 31: Final validation

- [ ] **Step 1: Run full test suite**

```bash
node --test tests/clank-tools.test.cjs
```

Expected: all tests pass, zero failures, zero skipped.

- [ ] **Step 2: Verify all files exist**

```bash
ls commands/clank/ agents/ clank/workflows/ clank/references/ clank/templates/ bin/
```

Expected: all 4 commands, 4 agents, 4 workflows, 6 references, 4 templates, 2 bin files.

- [ ] **Step 3: Verify plugin.json is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json', 'utf8')); console.log('valid')"
```

- [ ] **Step 4: Verify clank-tools help runs**

```bash
node bin/clank-tools.cjs help
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git status  # verify nothing unexpected
git commit -m "chore: Clank v0.1.0 complete"
```

Expected: clean working tree.
