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

/**
 * Records the exec the tunnel asks for, and whether its channel was closed.
 *
 * The readiness probe is modelled rather than stubbed away: `startRunTunnel`
 * will not return until the client's ports are listening, so a fake that always
 * answered `ready` would make the tests pass for a reason production does not
 * have. `listening` starts false and is flipped when the channel is opened,
 * which is what a real container does.
 */
function recordingEngine(opts: { neverBinds?: boolean } = {}) {
	const execs: ExecConfig[] = [];
	const state = {
		closed: false,
		listening: false,
		stderr: undefined as ((c: Uint8Array) => void) | undefined,
		// Captured so a spec can make the channel die the way a dropped exec or a
		// dropped WebSocket does, which is the case nothing could observe before.
		fireClose: undefined as (() => void) | undefined,
	};
	const probes: string[] = [];
	const base = createStubDocker({
		openExecChannel: async (_id: string, config: ExecConfig): Promise<ContainerByteChannel> => {
			execs.push(config);
			state.listening = true;
			return {
				write: () => {},
				onData: () => {},
				onStderr: (handler) => {
					state.stderr = handler;
				},
				onClose: (handler) => {
					state.fireClose = handler;
				},
				close: () => {
					state.closed = true;
				},
			};
		},
	});
	// Layered *outside* `createStubDocker`, which answers the readiness probe for
	// every other spec so their runs are not left waiting it out. This spec is the
	// one testing that probe, so it has to see and answer it itself.
	const engine = {
		...base,
		execCreate: async (_id: string, config: ExecConfig) => {
			probes.push((config?.Cmd ?? []).join(' '));
			return 'exec-1';
		},
		execStart: async () => ({
			stdout: state.listening && !opts.neverBinds ? 'ready\n' : '',
			stderr: '',
			exitCode: 0,
		}),
	} as unknown as ReturnType<typeof createStubDocker>;
	return { engine, execs, state, probes };
}

const ADDRESSES = {
	proxy: { host: '127.0.0.1', port: 1 },
	mcp: { host: '127.0.0.1', port: 2 },
	ssh: { host: '127.0.0.1', port: 3 },
};

function start(
	root: string,
	engine: ReturnType<typeof recordingEngine>['engine'],
	listenTimeoutMs?: number,
) {
	return startRunTunnel({
		...(listenTimeoutMs === undefined ? {} : { listenTimeoutMs }),
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

	it('reports a channel that dies on its own, which nothing could see before', async () => {
		// The transcript that motivated this: the tunnel bound (so the run started),
		// then died. The container stayed up, so no container_* transition fired,
		// nothing in the run loop looked at the tunnel again, and the agent burned a
		// full max-effort budget with no Hezo tools - recorded as "produced no
		// output", which reads as a lazy model rather than a dead transport.
		const root = scratch();
		const { engine, state } = recordingEngine();
		const tunnel = await start(root, engine);

		const reasons: string[] = [];
		tunnel.onClosed((r) => reasons.push(r));
		expect(reasons).toEqual([]);

		state.fireClose?.();

		expect(reasons.length).toBe(1);
		expect(reasons[0]).toMatch(/closed/i);
	});

	it('does not report a teardown the caller asked for', async () => {
		// Every run ends with the tunnel closing. Only the ones that close *first*
		// are failures, so conflating the two would fail every healthy run.
		const root = scratch();
		const { engine, state } = recordingEngine();
		const tunnel = await start(root, engine);

		const reasons: string[] = [];
		tunnel.onClosed((r) => reasons.push(r));

		tunnel.close();
		// The channel's own close handler fires as a consequence of our teardown.
		state.fireClose?.();

		expect(reasons).toEqual([]);
	});

	it('reports an unexpected close once, however many times the channel says so', async () => {
		const root = scratch();
		const { engine, state } = recordingEngine();
		const tunnel = await start(root, engine);

		const reasons: string[] = [];
		tunnel.onClosed((r) => reasons.push(r));
		state.fireClose?.();
		state.fireClose?.();
		state.fireClose?.();

		expect(reasons.length).toBe(1);
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

	it('does not return until the client is actually listening', async () => {
		// Opening the channel only *starts* the client; it still has to boot and
		// bind. Returning early hands the run endpoints that refuse connections,
		// and a coding CLI that gets ECONNREFUSED on the MCP endpoint marks that
		// server failed for the whole session rather than retrying - so the agent
		// runs with no Hezo tools and the run reads as it having done nothing.
		// Measured on Daytona: the listeners appear ~1s after the channel opens.
		const root = scratch();
		const { engine, probes } = recordingEngine();
		const tunnel = await start(root, engine);

		const port = Number(/:(\d+)$/.exec(tunnel.endpoints.hezoBaseUrl)?.[1]);
		expect(probes.length).toBeGreaterThan(0);
		// It asks about the ports it just handed out, on loopback specifically -
		// a listener on another interface is not what the container was promised.
		const hex = port.toString(16).toUpperCase().padStart(4, '0');
		expect(probes.join(' ')).toContain(`0100007F:${hex}`);
	});

	it('fails the run when the client never binds', async () => {
		// There is no useful degraded mode: without the tunnel the container
		// cannot reach MCP, the egress proxy or the ssh-agent, so proceeding
		// would produce exactly the silent no-op run this exists to prevent.
		const root = scratch();
		const { engine, state } = recordingEngine({ neverBinds: true });
		await expect(start(root, engine, 500)).rejects.toThrow(/did not bind its ports/);
		// And it does not leak the channel it opened on the way out.
		expect(state.closed).toBe(true);
	});
});
