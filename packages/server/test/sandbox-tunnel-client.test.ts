import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect as netConnect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ByteChannel, TunnelMux } from '../src/services/sandbox/tunnel/mux';
import { nodeTunnelSocket } from '../src/services/sandbox/tunnel/net-socket';
import { hostNeedsProxy } from '../src/services/sandbox/tunnel/split-routing';

/**
 * The in-container client is a plain Node script in the image, so its copy of
 * the frame protocol and the split-routing rule cannot be imported and type-
 * checked against the server's. This drives the **real script** against the
 * server's **real multiplexer** over a pipe, which is what keeps the two copies
 * honest - a divergence in framing, credit accounting or host matching fails
 * here rather than in production.
 */

const CLIENT = join(__dirname, '../../../docker/scripts/hezo-tunnel');

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanups.splice(0).reverse()) fn();
});

async function listenOn(handler: (socket: import('node:net').Socket) => void): Promise<number> {
	const server: Server = createServer(handler);
	cleanups.push(() => server.close());
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address === 'string' || address === null) throw new Error('no port');
	return address.port;
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address === 'string' || address === null) throw new Error('no port');
	await new Promise((r) => server.close(r));
	return address.port;
}

interface Harness {
	child: ChildProcessWithoutNullStreams;
	ports: { proxy: number; mcp: number; ssh: number };
}

interface TunnelOptions {
	/** Where each target key resolves on the "Hezo" side. */
	targets: { proxy?: number; mcp?: number; ssh?: number };
	policy?: { proxiedHosts: string[]; proxyEverything: boolean };
}

/**
 * Boot the real client with a mux on the other end of its stdio.
 *
 * Retried, because {@link freePort} can only report a port that was free a
 * moment ago: it closes its probe before the client binds, so anything else on
 * the machine - a sibling test, another shard on the same runner - can take the
 * port in that gap, and the client then fails to bind one this harness has
 * already written into its config. That is the harness losing a race, not the
 * client misbehaving, and a fresh set of ports settles it. A genuine bind
 * failure fails all three attempts and arrives with the client's own stderr.
 */
async function startTunnel(opts: TunnelOptions): Promise<Harness> {
	let last: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await bootTunnel(opts);
		} catch (e) {
			last = e;
		}
	}
	throw last;
}

async function bootTunnel(opts: TunnelOptions): Promise<Harness> {
	const ports = { proxy: await freePort(), mcp: await freePort(), ssh: await freePort() };
	const dir = mkdtempSync(join(tmpdir(), 'hezo-tunnel-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = join(dir, 'config.json');
	writeFileSync(
		configPath,
		JSON.stringify({
			ports,
			policy: opts.policy ?? { proxiedHosts: [], proxyEverything: false },
		}),
	);

	const child = spawn(process.execPath, [CLIENT, configPath], { stdio: 'pipe' });
	cleanups.push(() => child.kill('SIGKILL'));

	const channel: ByteChannel = {
		write: (data) => {
			child.stdin.write(data);
		},
		close: () => child.kill('SIGKILL'),
	};
	const mux = new TunnelMux(channel, async (target) => {
		const port = opts.targets[target];
		if (!port) throw new Error(`no target for ${target}`);
		return await new Promise((resolve, reject) => {
			const socket = netConnect({ host: '127.0.0.1', port });
			socket.once('error', reject);
			socket.once('connect', () => resolve(nodeTunnelSocket(socket)));
		});
	});
	cleanups.push(() => mux.closeAll());
	child.stdout.on('data', (chunk: Buffer) => void mux.handleChunk(new Uint8Array(chunk)));
	// Kept for the failure message: without it a client that refused to bind says
	// only that nothing ever listened, when it printed the reason on stderr.
	let stderr = '';
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += String(chunk);
	});

	// The client binds its three listeners asynchronously after start-up. Poll
	// until they actually accept rather than sleeping a fixed amount: a fixed wait
	// is only ever long enough on an unloaded machine, and on a busy CI runner it
	// surfaces as an ECONNREFUSED that reads like a protocol bug.
	try {
		await Promise.all(Object.values(ports).map((port) => waitForListener(port)));
	} catch (e) {
		// Free the ports before the retry asks for a new set, rather than leaving a
		// half-started client holding them until the suite's own cleanup runs.
		child.kill('SIGKILL');
		mux.closeAll();
		throw new Error(`${String(e)}${stderr ? ` - client stderr: ${stderr.trim()}` : ''}`);
	}
	return { child, ports };
}

/** Resolve once a TCP connect to `port` succeeds, or throw at the deadline. */
async function waitForListener(port: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const ok = await new Promise<boolean>((resolve) => {
			const socket = netConnect({ host: '127.0.0.1', port });
			const done = (value: boolean) => {
				socket.destroy();
				resolve(value);
			};
			socket.once('connect', () => done(true));
			socket.once('error', () => done(false));
		});
		if (ok) return;
		if (Date.now() >= deadline) throw new Error(`tunnel client never bound port ${port}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** Connect, send, and collect until the peer closes. */
function exchange(port: number, payload: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: '127.0.0.1', port }, () => socket.write(payload));
		let out = '';
		socket.on('data', (c) => {
			out += c.toString();
		});
		socket.on('close', () => resolve(out));
		socket.on('error', reject);
		setTimeout(() => {
			socket.destroy();
			reject(new Error(`timed out; got ${JSON.stringify(out)}`));
		}, 8000);
	});
}

describe('hezo-tunnel client', () => {
	it('carries a tunnelled MCP connection end to end', async () => {
		// The whole point: bytes written inside the container reach a Hezo-side
		// listener and its reply comes back, over one multiplexed channel.
		const target = await listenOn((socket) => {
			socket.on('data', (chunk) => {
				socket.end(`echo:${chunk.toString()}`);
			});
		});
		const { ports } = await startTunnel({ targets: { mcp: target } });
		expect(await exchange(ports.mcp, 'hello-mcp')).toBe('echo:hello-mcp');
	});

	it('keeps concurrent streams separate', async () => {
		const target = await listenOn((socket) => {
			socket.on('data', (chunk) => socket.end(`r:${chunk.toString()}`));
		});
		const { ports } = await startTunnel({ targets: { mcp: target, ssh: target } });
		const [a, b] = await Promise.all([exchange(ports.mcp, 'one'), exchange(ports.ssh, 'two')]);
		expect([a, b]).toEqual(['r:one', 'r:two']);
	});

	it('carries a payload larger than the frame cap intact', async () => {
		// Exercises the split-and-reassemble path plus credit accounting; a
		// mismatch between the two copies of the protocol shows up as truncation.
		const body = 'x'.repeat(200_000);
		const target = await listenOn((socket) => {
			let seen = 0;
			socket.on('data', (chunk) => {
				seen += chunk.length;
				if (seen >= body.length) socket.end(`len:${seen}`);
			});
		});
		const { ports } = await startTunnel({ targets: { mcp: target } });
		expect(await exchange(ports.mcp, body)).toBe(`len:${body.length}`);
	});
});

describe('hezo-tunnel split routing', () => {
	it('sends a policy-matched host through Hezo', async () => {
		// The proxy leg speaks CONNECT itself; a matched host is handed to the
		// mux, which is standing in for the egress proxy here.
		const seen: string[] = [];
		const proxyTarget = await listenOn((socket) => {
			socket.on('data', (chunk) => {
				seen.push(chunk.toString().split('\r\n')[0]);
				socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
			});
		});
		const { ports } = await startTunnel({
			targets: { proxy: proxyTarget },
			policy: { proxiedHosts: ['api.github.com'], proxyEverything: false },
		});

		await exchange(
			ports.proxy,
			'CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com\r\n\r\n',
		);
		expect(seen[0]).toBe('CONNECT api.github.com:443 HTTP/1.1');
	});

	it('sends a wildcard-matched subdomain through Hezo', async () => {
		// The syntax the vault actually stores. `allowed_hosts` holds `*.example.com`
		// - it is what the shipped connector registry uses (`*.datocms.com`,
		// `*.sentry.io`) and what the egress proxy matches on - but this client and
		// the policy builder had both been written against a leading-dot form, so a
		// wildcard entry matched nothing here. The container connected direct, the
		// placeholder was never substituted, and the agent got a 401 from the
		// provider with nothing naming the cause.
		const seen: string[] = [];
		const proxyTarget = await listenOn((socket) => {
			socket.on('data', (chunk) => {
				seen.push(chunk.toString().split('\r\n')[0]);
				socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
			});
		});
		const { ports } = await startTunnel({
			targets: { proxy: proxyTarget },
			policy: { proxiedHosts: ['*.datocms.com'], proxyEverything: false },
		});

		await exchange(
			ports.proxy,
			'CONNECT mcp.datocms.com:443 HTTP/1.1\r\nHost: mcp.datocms.com\r\n\r\n',
		);
		expect(seen[0]).toBe('CONNECT mcp.datocms.com:443 HTTP/1.1');
	});

	it('dials an unmatched host directly instead of through Hezo', async () => {
		// npm, apt and playwright install must not push their payload through the
		// Hezo instance. The origin here answers on loopback so "direct" is
		// observable: the proxy-side listener must see nothing.
		const proxied: string[] = [];
		const proxyTarget = await listenOn((socket) => {
			socket.on('data', (c) => proxied.push(c.toString()));
		});
		const origin = await listenOn((socket) => {
			socket.on('data', () => socket.end('DIRECT-OK'));
		});
		const { ports } = await startTunnel({
			targets: { proxy: proxyTarget },
			policy: { proxiedHosts: ['api.github.com'], proxyEverything: false },
		});

		const out = await exchange(
			ports.proxy,
			`CONNECT 127.0.0.1:${origin} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET / HTTP/1.1\r\n\r\n`,
		);
		expect(out).toContain('200 Connection Established');
		expect(out).toContain('DIRECT-OK');
		expect(proxied).toEqual([]);
	});

	it('proxies everything when the policy says so', async () => {
		// One allow_all_hosts secret defeats split routing instance-wide, which is
		// the argument for keeping request_credential's explicit-hosts rule.
		const seen: string[] = [];
		const proxyTarget = await listenOn((socket) => {
			socket.on('data', (chunk) => {
				seen.push(chunk.toString().split('\r\n')[0]);
				socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
			});
		});
		const { ports } = await startTunnel({
			targets: { proxy: proxyTarget },
			policy: { proxiedHosts: [], proxyEverything: true },
		});

		await exchange(ports.proxy, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n');
		expect(seen[0]).toBe('CONNECT registry.npmjs.org:443 HTTP/1.1');
	});

	it('treats a wildcard as covering subdomains only, exactly as the server copy does', async () => {
		// The apex is not a subdomain - the convention TLS certificates use, and
		// what the shipped connector registry assumes when it lists `sentry.io`
		// *and* `*.sentry.io`. Asserted through the real client because this file is
		// a hand-written copy of the shared matcher, so "the server agrees" has to
		// be shown here rather than reasoned about.
		const proxied: string[] = [];
		const proxyTarget = await listenOn((socket) => {
			socket.on('data', (c) => proxied.push(c.toString()));
		});
		const origin = await listenOn((socket) => {
			socket.on('data', () => socket.end('DIRECT-OK'));
		});
		const { ports } = await startTunnel({
			targets: { proxy: proxyTarget },
			policy: { proxiedHosts: ['*.github.com'], proxyEverything: false },
		});

		// `127.0.0.1` stands in for the apex: neither is a subdomain of the entry,
		// and only a loopback origin makes "went direct" observable.
		const out = await exchange(
			ports.proxy,
			`CONNECT 127.0.0.1:${origin} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET / HTTP/1.1\r\n\r\n`,
		);
		expect(out).toContain('DIRECT-OK');
		expect(proxied).toEqual([]);
		expect(
			hostNeedsProxy({ proxiedHosts: ['*.github.com'], proxyEverything: false }, 'github.com'),
		).toBe(false);
	});
});
