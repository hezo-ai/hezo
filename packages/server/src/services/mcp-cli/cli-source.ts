/**
 * The `hezo-mcp` CLI, written into every run's container.
 *
 * Shipped as a string constant and written per run rather than baked into
 * `docker/Dockerfile.agent-base`, so its version can never drift from the server
 * that produced the manifest it reads. Same reasoning as `PROMPT_DELIVERY_SH`.
 *
 * It is deliberately **not** in `services/sandbox/proc-scripts.ts`. That module's
 * rule is that an in-container script and *its parser* live together, because
 * Hezo parses the output. Here the agent is the consumer and Hezo parses nothing,
 * so the coupling that rule protects does not exist.
 *
 * Dependency-free Node ESM: the image bakes Node but not the MCP SDK, and adding
 * an npm install to the run path would put a registry fetch in front of every
 * agent's first tool call.
 */
export const HEZO_MCP_CLI_SOURCE = `#!/usr/bin/env node
// hezo-mcp - reach this run's MCP servers on demand.
//
// Hezo no longer loads every connector's tool schemas into the model's context.
// This reads the per-run manifest and talks MCP itself, so a schema costs tokens
// only when the agent asks for one.
//
// Auth values in the manifest are __HEZO_SECRET_*__ placeholders. They are sent
// verbatim; the Hezo egress proxy substitutes the real credential at request
// time. Nothing here ever sees a secret.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const MANIFEST = process.env.HEZO_MCP_MANIFEST;
const OUT = process.stdout;

function die(msg, code) {
  process.stderr.write('hezo-mcp: ' + msg + '\\n');
  process.exit(code === undefined ? 1 : code);
}

function loadManifest() {
  if (!MANIFEST) die('HEZO_MCP_MANIFEST is not set; this run has no MCP manifest.');
  let raw;
  try {
    raw = readFileSync(MANIFEST, 'utf8');
  } catch (e) {
    die('cannot read manifest at ' + MANIFEST + ': ' + e.message);
  }
  const m = JSON.parse(raw);
  if (m.version !== 1) die('manifest version ' + m.version + ' is newer than this CLI understands.');
  return m;
}

function findServer(manifest, name) {
  const s = manifest.servers.find((x) => x.name === name);
  if (!s) {
    const known = manifest.servers.map((x) => x.name).join(', ') || '(none)';
    die('unknown server "' + name + '". Available: ' + known);
  }
  return s;
}

// A tool the run's allowlist withholds. Advisory only - the egress proxy is the
// enforcement point and would refuse the call regardless - but saying so here
// turns a confusing upstream rejection into a local, actionable message.
function isEnabled(server, tool) {
  if (server.disabledTools && server.disabledTools.indexOf(tool) !== -1) return false;
  if (server.enabledTools) return server.enabledTools.indexOf(tool) !== -1;
  return true;
}

// ---------------------------------------------------------------- transports

function parseSse(text, wantId) {
  // A streamable-HTTP server may answer with an event stream. Collect the data
  // payloads and return the one carrying our id; ignore keep-alives and any
  // server-initiated notification that arrives alongside.
  let found = null;
  for (const line of text.split('\\n')) {
    if (line.indexOf('data:') !== 0) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      continue;
    }
    if (msg.id === wantId) found = msg;
  }
  return found;
}

function httpClient(server) {
  let sessionId = null;
  let nextId = 1;
  const post = async (method, params, isNotification) => {
    const id = isNotification ? undefined : nextId++;
    const body = { jsonrpc: '2.0', method: method };
    if (id !== undefined) body.id = id;
    if (params !== undefined) body.params = params;
    const headers = Object.assign({}, server.headers || {}, {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetch(server.url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (isNotification) return null;
    const text = await res.text();
    if (!res.ok) {
      die('server "' + server.name + '" returned HTTP ' + res.status + ': ' + text.slice(0, 500));
    }
    const ct = res.headers.get('content-type') || '';
    const msg = ct.indexOf('text/event-stream') !== -1 ? parseSse(text, id) : JSON.parse(text);
    if (!msg) die('no JSON-RPC response for ' + method + ' from "' + server.name + '".');
    if (msg.error) {
      die('server "' + server.name + '" refused ' + method + ': ' + JSON.stringify(msg.error));
    }
    return msg.result;
  };
  return {
    async open() {
      await post('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'hezo-mcp', version: '1' },
      });
      await post('notifications/initialized', undefined, true);
    },
    request: (method, params) => post(method, params, false),
    close() {},
  };
}

function stdioClient(server) {
  const child = spawn(server.command, server.args || [], {
    env: Object.assign({}, process.env, server.env || {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (e) => die('cannot spawn "' + server.name + '": ' + e.message));
  let buffer = '';
  const waiters = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try {
        msg = JSON.parse(t);
      } catch {
        continue;
      }
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  let nextId = 1;
  const send = (method, params, isNotification) =>
    new Promise((resolve) => {
      const body = { jsonrpc: '2.0', method: method };
      if (params !== undefined) body.params = params;
      if (isNotification) {
        child.stdin.write(JSON.stringify(body) + '\\n');
        resolve(null);
        return;
      }
      const id = nextId++;
      body.id = id;
      waiters.set(id, resolve);
      child.stdin.write(JSON.stringify(body) + '\\n');
    });
  return {
    async open() {
      await send('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'hezo-mcp', version: '1' },
      });
      await send('notifications/initialized', undefined, true);
    },
    async request(method, params) {
      const msg = await send(method, params, false);
      if (msg.error) {
        die('server "' + server.name + '" refused ' + method + ': ' + JSON.stringify(msg.error));
      }
      return msg.result;
    },
    close() {
      try {
        child.stdin.end();
        child.kill();
      } catch {}
    },
  };
}

const clientFor = (server) => (server.transport === 'stdio' ? stdioClient(server) : httpClient(server));

// ------------------------------------------------------------------- catalog

// Cached per run, not per call: \`search\` then \`describe\` then \`call\` is the
// normal sequence and would otherwise pay three handshakes. The per-run home is
// discarded with the run, so there is nothing to invalidate.
function cachePath(server) {
  return join(dirname(MANIFEST), '.cache', server.name + '.json');
}

async function toolsOf(server) {
  const p = cachePath(server);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {}
  }
  const client = clientFor(server);
  await client.open();
  const tools = [];
  let cursor;
  // Paged: a server with more tools than fit one page would otherwise be
  // silently truncated - the exact bug Hezo's own paging rules exist to prevent.
  for (;;) {
    const res = await client.request('tools/list', cursor ? { cursor: cursor } : {});
    for (const t of res.tools || []) tools.push(t);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  client.close();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(tools), { mode: 0o600 });
  } catch {}
  return tools;
}

const firstLine = (s) => String(s || '').split('\\n')[0].trim();

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ------------------------------------------------------------------ commands

async function cmdServers(manifest) {
  if (manifest.servers.length === 0) {
    OUT.write('No MCP servers are configured for this run.\\n');
    return;
  }
  for (const s of manifest.servers) {
    let note = '';
    if (s.enabledTools) note = '  (' + s.enabledTools.length + ' of its tools enabled for this run)';
    OUT.write(s.name + '  [' + s.transport + ']' + note + '\\n');
  }
  OUT.write('\\nhezo-mcp search <query> to find a tool.\\n');
}

async function cmdSearch(manifest, query, only, limit) {
  const needles = query.toLowerCase().split(/\\s+/).filter(Boolean);
  const servers = only ? [findServer(manifest, only)] : manifest.servers;
  const hits = [];
  for (const s of servers) {
    let tools;
    try {
      tools = await toolsOf(s);
    } catch (e) {
      process.stderr.write('hezo-mcp: could not list "' + s.name + '": ' + e.message + '\\n');
      continue;
    }
    for (const t of tools) {
      if (!isEnabled(s, t.name)) continue;
      const hay = (t.name + ' ' + (t.description || '')).toLowerCase();
      // Every needle must appear, so extra words narrow rather than widen.
      if (!needles.every((n) => hay.indexOf(n) !== -1)) continue;
      hits.push({ server: s.name, name: t.name, description: firstLine(t.description) });
    }
  }
  if (hits.length === 0) {
    OUT.write('No tool matches "' + query + '".\\n');
    OUT.write('hezo-mcp servers lists what this run can reach.\\n');
    return;
  }
  for (const h of hits.slice(0, limit)) {
    OUT.write(h.server + ' ' + h.name + '  -  ' + truncate(h.description, 120) + '\\n');
  }
  if (hits.length > limit) {
    OUT.write('\\n' + (hits.length - limit) + ' more. Narrow the query, or raise --limit.\\n');
  }
  OUT.write('\\nhezo-mcp describe <server> <tool> for the full argument schema.\\n');
}

async function cmdDescribe(manifest, name, tool) {
  const server = findServer(manifest, name);
  const tools = await toolsOf(server);
  const t = tools.find((x) => x.name === tool);
  if (!t) die('server "' + name + '" advertises no tool "' + tool + '".');
  if (!isEnabled(server, tool)) {
    die('tool "' + tool + '" is not enabled for this run. Ask an admin to enable it.');
  }
  OUT.write(name + ' ' + t.name + '\\n');
  if (t.description) OUT.write('\\n' + t.description.trim() + '\\n');
  OUT.write('\\nArguments (JSON schema):\\n');
  OUT.write(JSON.stringify(t.inputSchema || {}, null, 2) + '\\n');
  OUT.write('\\nCall it:\\n');
  OUT.write("  hezo-mcp call " + name + ' ' + t.name + " --args '{...}'\\n");
  OUT.write('  ...or pipe the JSON on stdin with \`--args -\` to avoid shell quoting.\\n');
}

function renderContent(result) {
  // The MCP result shape: { content: [{type:'text',text}], isError? }. Print the
  // text parts raw so the agent sees what the tool returned, not a wrapper.
  if (result && Array.isArray(result.content)) {
    const parts = [];
    for (const c of result.content) {
      if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else parts.push(JSON.stringify(c));
    }
    return parts.join('\\n');
  }
  return JSON.stringify(result, null, 2);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdCall(manifest, name, tool, argsRaw) {
  const server = findServer(manifest, name);
  if (!isEnabled(server, tool)) {
    die('tool "' + tool + '" is not enabled for this run. Ask an admin to enable it.');
  }
  let args = {};
  if (argsRaw === '-') argsRaw = await readStdin();
  if (argsRaw && argsRaw.trim()) {
    try {
      args = JSON.parse(argsRaw);
    } catch (e) {
      die('--args is not valid JSON: ' + e.message + '\\nUse \`--args -\` and pipe it in to avoid shell quoting.');
    }
  }
  const client = clientFor(server);
  await client.open();
  const result = await client.request('tools/call', { name: tool, arguments: args });
  client.close();
  OUT.write(renderContent(result) + '\\n');
  if (result && result.isError) process.exit(1);
}

// ---------------------------------------------------------------------- main

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

const USAGE = [
  'hezo-mcp - reach this run\\'s MCP servers on demand.',
  '',
  '  hezo-mcp servers                       what this run can reach',
  '  hezo-mcp search <query> [--server S] [--limit N]',
  '  hezo-mcp describe <server> <tool>      full argument schema',
  '  hezo-mcp call <server> <tool> --args \\'{...}\\'   (or --args - to read stdin)',
  '',
].join('\\n');

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    OUT.write(USAGE);
    return;
  }
  const manifest = loadManifest();
  if (cmd === 'servers') return cmdServers(manifest);
  if (cmd === 'search') {
    const positional = argv.slice(1).filter((a, i, all) => {
      if (a.indexOf('--') === 0) return false;
      return all[i - 1] !== '--server' && all[i - 1] !== '--limit';
    });
    if (positional.length === 0) die('search needs a query. ' + USAGE);
    const limit = Number(flag(argv, '--limit') || 25);
    return cmdSearch(manifest, positional.join(' '), flag(argv, '--server'), limit);
  }
  if (cmd === 'describe') {
    if (!argv[1] || !argv[2]) die('describe needs <server> and <tool>.');
    return cmdDescribe(manifest, argv[1], argv[2]);
  }
  if (cmd === 'call') {
    if (!argv[1] || !argv[2]) die('call needs <server> and <tool>.');
    return cmdCall(manifest, argv[1], argv[2], flag(argv, '--args'));
  }
  die('unknown command "' + cmd + '".\\n' + USAGE);
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
`;
