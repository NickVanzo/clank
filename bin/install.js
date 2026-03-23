#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const PLUGIN_ROOT = path.join(__dirname, '..');
const HOME = os.homedir();
const PROJECT_ROOT = process.env.CLANK_INSTALL_PROJECT || process.cwd();

// ── Prompts ───────────────────────────────────────────────────────────────────

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ── File helpers ──────────────────────────────────────────────────────────────

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readJson(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── Config writers ────────────────────────────────────────────────────────────

function writeMcpConfig(claudeJsonPath) {
  const cfg = readJson(claudeJsonPath);
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.clank = { type: 'stdio', command: 'clank', args: ['serve', '--mcp'] };
  writeJson(claudeJsonPath, cfg);
}

function writePermissions(settingsPath) {
  const s = readJson(settingsPath);
  s.permissions = s.permissions || {};
  s.permissions.allow = s.permissions.allow || [];
  const tools = [
    'mcp__clank__clank_memory_record',
    'mcp__clank__clank_memory_summary',
    'mcp__clank__clank_memory_scope',
    'mcp__clank__clank_memory_baseline',
    'mcp__clank__clank_memory_run',
  ];
  for (const t of tools) {
    if (!s.permissions.allow.includes(t)) s.permissions.allow.push(t);
  }
  writeJson(settingsPath, s);
}

function writeSessionStartHook(settingsPath) {
  const s = readJson(settingsPath);
  s.hooks = s.hooks || {};
  s.hooks.SessionStart = s.hooks.SessionStart || [];
  // Remove any previous clank session-start entries
  s.hooks.SessionStart = s.hooks.SessionStart.filter(
    e => !JSON.stringify(e).includes('clank-tools memory-summary')
  );
  s.hooks.SessionStart.push({
    matcher: '.*',
    hooks: [{ type: 'command', command: 'clank-tools memory-summary' }],
  });
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

function writeClaudeMd(claudeMdPath) {
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

function initProjectClankDir(projectRoot) {
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
  // Add memory.db to .gitignore
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nClank installer\n');

  // 1. Global or local?
  const locationAnswer = await ask('Install globally (~/.claude) or locally (./.claude)? [G/l] ');
  const isLocal = locationAnswer.toLowerCase() === 'l';
  const claudeDir = isLocal ? path.join(PROJECT_ROOT, '.claude') : path.join(HOME, '.claude');
  const claudeJsonPath = isLocal ? path.join(PROJECT_ROOT, '.claude.json') : path.join(HOME, '.claude.json');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // 2. Global npm install so `clank` binary is on PATH for the MCP server
  //    Use PLUGIN_ROOT (the directory containing this installer) so this works
  //    both during development (local path) and in production (npx extracts package).
  const { execSync } = require('node:child_process');
  console.log('Installing clank globally...');
  execSync(`npm install -g "${PLUGIN_ROOT}"`, { stdio: 'inherit' });
  console.log('✓ clank installed globally');

  // 3. Copy plugin files (existing behaviour)
  const CLAUDE_LOCAL = path.join(PROJECT_ROOT, '.claude');
  copyDir(path.join(PLUGIN_ROOT, 'commands', 'clank'), path.join(CLAUDE_LOCAL, 'commands', 'clank'));
  console.log('✓ commands/clank/');
  copyDir(path.join(PLUGIN_ROOT, 'agents'), path.join(CLAUDE_LOCAL, 'agents'));
  console.log('✓ agents/');
  copyDir(path.join(PLUGIN_ROOT, 'clank'), path.join(path.join(HOME, '.claude'), 'clank'));
  console.log('✓ ~/.claude/clank/');
  copyDir(path.join(PLUGIN_ROOT, 'bin'), path.join(path.join(HOME, '.claude'), 'clank', 'bin'));
  console.log('✓ ~/.claude/clank/bin/');

  // 4. MCP server config
  writeMcpConfig(claudeJsonPath);
  console.log(`✓ MCP server registered in ${isLocal ? './.claude.json' : '~/.claude.json'}`);

  // 5. Auto-allow permissions?
  const allowAnswer = await ask('Auto-allow clank_memory_* MCP tools? [Y/n] ');
  if (allowAnswer.toLowerCase() !== 'n') {
    writePermissions(settingsPath);
    console.log(`✓ Permissions added to ${isLocal ? './.claude/settings.json' : '~/.claude/settings.json'}`);
  }

  // 6. SessionStart hook
  writeSessionStartHook(settingsPath);
  console.log(`✓ SessionStart hook registered`);

  // 7. CLAUDE.md
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  writeClaudeMd(claudeMdPath);
  console.log(`✓ CLAUDE.md updated`);

  // 8. Project init
  initProjectClankDir(PROJECT_ROOT);
  console.log('✓ .clank/ initialized in project');

  console.log('\nClank installed. Restart Claude Code to load the MCP server. Run /clank:audit to get started.\n');
}

main().catch(err => {
  console.error('Installation failed:', err.message);
  process.exit(1);
});
