#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const PROJECT_ROOT = process.env.CLANK_PROJECT_ROOT || process.cwd();
const CLANK_DIR = path.join(PROJECT_ROOT, '.clank');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'clank_reports');

const [,, command, ...args] = process.argv;

const commands = { 'report-id': cmdReportId, 'validate': cmdValidate, 'recent': cmdRecent };

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
