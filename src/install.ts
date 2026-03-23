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
