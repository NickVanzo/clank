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
