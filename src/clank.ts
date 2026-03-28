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
