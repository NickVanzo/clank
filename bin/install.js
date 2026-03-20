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
copyDir(
  path.join(PLUGIN_ROOT, 'commands', 'clank'),
  path.join(CLAUDE_LOCAL, 'commands', 'clank')
);
console.log('✓ commands/clank/');

// 2. Copy agents
copyDir(path.join(PLUGIN_ROOT, 'agents'), path.join(CLAUDE_LOCAL, 'agents'));
console.log('✓ agents/');

// 3. Copy clank/ references, workflows, templates globally
copyDir(path.join(PLUGIN_ROOT, 'clank'), path.join(CLAUDE_DIR, 'clank'));
console.log('✓ ~/.claude/clank/');

// 4. Copy bin/ globally
copyDir(
  path.join(PLUGIN_ROOT, 'bin'),
  path.join(CLAUDE_DIR, 'clank', 'bin')
);
console.log('✓ ~/.claude/clank/bin/');

// 5. Register session-start hook
const settingsPath = path.join(CLAUDE_LOCAL, 'settings.json');
const settings = readSettings(settingsPath);
settings.hooks = settings.hooks || {};
settings.hooks['session-start'] = settings.hooks['session-start'] || [];
const hookCmd = path.join(CLAUDE_DIR, 'clank', 'hooks', 'session-start');
if (!settings.hooks['session-start'].includes(hookCmd)) {
  settings.hooks['session-start'].push(hookCmd);
}
writeSettings(settingsPath, settings);
console.log('✓ session-start hook registered');

// 6. Copy hook
const hooksDir = path.join(CLAUDE_DIR, 'clank', 'hooks');
fs.mkdirSync(hooksDir, { recursive: true });
fs.copyFileSync(
  path.join(PLUGIN_ROOT, 'hooks', 'session-start'),
  path.join(hooksDir, 'session-start')
);
fs.chmodSync(path.join(hooksDir, 'session-start'), 0o755);

// 7. Create .clank/ in project
fs.mkdirSync(path.join(PROJECT_ROOT, '.clank', 'journals'), { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT, '.clank', 'scratch'), { recursive: true });
const configPath = path.join(PROJECT_ROOT, '.clank', 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify({
    codegraph_suggestion_shown: false,
    last_audit: null,
    last_bootstrap: null,
    last_refactor: null,
    last_watch: null,
    test_run_command: null,
  }, null, 2));
}
console.log('✓ .clank/ initialized in project');

console.log('\nClank installed. Run /clank:audit to get started.');
