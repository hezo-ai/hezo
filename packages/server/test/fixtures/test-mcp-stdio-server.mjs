#!/usr/bin/env node
// Minimal stdio MCP server used by the local-MCP integration tests. Speaks
// JSON-RPC line-delimited per the MCP stdio transport spec: each line on
// stdin is a JSON-RPC request; each response is a JSON-encoded line on
// stdout. Exposes a single `echo` tool that returns its `message` arg
// prefixed with "echo:".
//
// Kept dependency-free (no MCP SDK import) so the fixture works regardless
// of how the host installs the test workspace — mirrors how a published
// stdio MCP would be invoked under /workspace/.hezo/mcp/<name>/.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `parse error: ${err?.message ?? err}` },
    });
    return;
  }

  const { id = null, method, params = {} } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hezo-test-mcp-stdio', version: '0.0.0' },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes the provided message back as the result.',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const message = params.arguments?.message ?? '';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `echo:${message}` }],
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
});

rl.on('close', () => process.exit(0));
