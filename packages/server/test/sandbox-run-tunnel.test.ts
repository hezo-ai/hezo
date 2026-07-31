import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerRunUser } from '../src/services/container-user';
import { hostSandboxFiles } from '../src/services/sandbox/files';
import { startRunTunnel } from '../src/services/sandbox/tunnel/run-tunnel';
import type { ContainerByteChannel, ExecConfig } from '../src/services/sandbox/types';
import { createStubDocker } from './helpers/app';

const NODE_USER: ContainerRunUser = { name: 'node', uid: 1000, gid: 1000 };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'hezo-run-tunnel-'));
	dirs.push(dir);
	return dir;
}

/** Records the exec the tunnel asks for, and whether its channel was closed. */
function recordingEngine() {
	const execs: ExecConfig[] = [];
	const state = { closed: false, stderr: undefined as ((c: Uint8Array) => void) | undefined };
	const engine = createStubDocker({
		openExecChannel: async (_id: string, config: ExecConfig): Promise<ContainerByteChannel> => {
			execs.push(config);
			return {
				write: () => {},
				onData: () => {},
				onStderr: (handler) => {
					state.stderr = handler;
				},
				onClose: () => {},
				close: () => {
					state.closed = true;
				},
			};
		},
	});
	return { engine, execs, state };
}

const ADDRESSES = {
	proxy: { host: '127.0.0.1', port: 1 },
	mcp: { host: '127.0.0.1', port: 2 },
	ssh: { host: '127.0.0.1', port: 3 },
};

function start(root: string, engine: ReturnType<typeof recordingEngine>['engine']) {
	return startRunTunnel({
		engine,
		containerId: 'c1',
		runUser: NODE_USER,
		files: hostSandboxFiles(root),
		configRelPath: '.hezo/tunnel/run-1.json',
		configContainerPath: '/workspace/.hezo/tunnel/run-1.json',
		addresses: ADDRESSES,
		policy: { proxiedHosts: ['api.github.com'], proxyEverything: false },
	});
}

describe('startRunTunnel', () => {
	it('writes the client its config, with the ports and the policy', async () => {
		const root = scratch();
		const { engine } = recordingEngine();
		await start(root, engine);

		const config = JSON.parse(readFileSync(join(root, '.hezo/tunnel/run-1.json'), 'utf8'));
		expect(Object.keys(config.ports).sort()).toEqual(['mcp', 'proxy', 'ssh']);
		expect(config.policy).toEqual({ proxiedHosts: ['api.github.com'], proxyEverything: false });
	});

	it('never puts a secret value in the config, only hostnames', async () => {
		const root = scratch();
		const { engine } = recordingEngine();
		await start(root, engine);
		const raw = readFileSync(join(root, '.hezo/tunnel/run-1.json'), 'utf8');
		expect(raw).toContain('api.github.com');
		expect(raw).not.toMatch(/secret|token|password|__HEZO_SECRET/i);
	});

	it('runs the client unelevated, as the agent’s own user', async () => {
		// It only listens on loopback and connects out, so root buys nothing and
		// would leave a root-owned process in a container the agent otherwise owns.
		const root = scratch();
		const { engine, execs } = recordingEngine();
		await start(root, engine);
		expect(execs[0].User).toBe('node');
		expect(execs[0].Cmd).toEqual(['hezo-tunnel', '/workspace/.hezo/tunnel/run-1.json']);
	});

	it('hands back loopback endpoints, naming the host nowhere', async () => {
		// This is what makes the run work for a container that is not on this
		// machine: the container never addresses the host at all.
		const root = scratch();
		const { engine } = recordingEngine();
		const tunnel = await start(root, engine);

		expect(tunnel.endpoints.proxyHost).toBe('127.0.0.1');
		expect(tunnel.endpoints.sshHost).toBe('127.0.0.1');
		// Whatever port the allocator handed this tunnel, the MCP origin names it.
		expect(tunnel.endpoints.hezoBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(JSON.stringify(tunnel.endpoints)).not.toContain('host.docker.internal');
	});

	it('closes the channel on teardown', async () => {
		// A live channel counts as activity on every backend, so a tunnel left
		// open keeps the container from going idle - which fails as a bill rather
		// than an error, with nothing to surface it.
		const root = scratch();
		const { engine, state } = recordingEngine();
		const tunnel = await start(root, engine);
		expect(state.closed).toBe(false);

		tunnel.close();
		expect(state.closed).toBe(true);
	});

	it('is idempotent on close', async () => {
		const root = scratch();
		const { engine } = recordingEngine();
		const tunnel = await start(root, engine);
		tunnel.close();
		expect(() => tunnel.close()).not.toThrow();
	});

	it('surfaces the client’s stderr, which is the only legible failure signal', async () => {
		const root = scratch();
		const { engine, state } = recordingEngine();
		await start(root, engine);
		// The client writes diagnostics but never protocol bytes there, so a
		// tunnel problem shows up as a log line rather than a dead stream.
		expect(state.stderr).toBeDefined();
		expect(() => state.stderr?.(new TextEncoder().encode('framing error'))).not.toThrow();
	});
});
