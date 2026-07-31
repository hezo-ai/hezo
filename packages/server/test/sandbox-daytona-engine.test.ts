import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	CreateSandboxSpec,
	DaytonaApi,
	DaytonaSandbox,
} from '../src/services/sandbox/daytona/client';
import { DaytonaEngine } from '../src/services/sandbox/daytona/engine';
import { clearImageDigestCache } from '../src/services/sandbox/image-ref';

interface Recorded {
	creates: CreateSandboxSpec[];
	commands: string[];
	started: string[];
	stopped: string[];
	destroyed: string[];
}

/**
 * A complete `DaytonaApi`, not a partial object cast into place - a stub that
 * omits a method only fails when production happens to call it.
 */
function fakeApi(
	overrides: Partial<DaytonaApi> = {},
	seed: DaytonaSandbox[] = [],
): { api: DaytonaApi; rec: Recorded; sandboxes: Map<string, DaytonaSandbox> } {
	const rec: Recorded = { creates: [], commands: [], started: [], stopped: [], destroyed: [] };
	const sandboxes = new Map(seed.map((s) => [s.id, s]));
	let n = 0;
	const api: DaytonaApi = {
		ping: async () => true,
		createSandbox: async (spec) => {
			rec.creates.push(spec);
			n += 1;
			const s: DaytonaSandbox = {
				id: `sbx-${n}`,
				state: 'started',
				labels: spec.labels,
				toolboxProxyUrl: 'https://proxy.test/toolbox',
			};
			sandboxes.set(s.id, s);
			return s;
		},
		getSandbox: async (id) => sandboxes.get(id) ?? null,
		listSandboxes: async (labels) => ({
			items: [...sandboxes.values()].filter((s) =>
				labels ? Object.entries(labels).every(([k, v]) => s.labels?.[k] === v) : true,
			),
		}),
		start: async (id) => {
			rec.started.push(id);
			const s = sandboxes.get(id);
			if (s) s.state = 'started';
		},
		stop: async (id) => {
			rec.stopped.push(id);
			const s = sandboxes.get(id);
			if (s) s.state = 'stopped';
		},
		destroy: async (id) => {
			rec.destroyed.push(id);
			sandboxes.delete(id);
		},
		getMetrics: async () => new Map(),
		openPty: async () => ({
			send: () => {},
			onData: () => {},
			onClose: () => {},
			close: () => {},
		}),
		execute: async (_s, command) => {
			rec.commands.push(command);
			return { exitCode: 0, output: '' };
		},
		executeStreaming: async (_s, command) => {
			rec.commands.push(command);
			return { exitCode: 0 };
		},
		...overrides,
	};
	return { api, rec, sandboxes };
}

afterEach(() => {
	clearImageDigestCache();
	vi.restoreAllMocks();
});

/** A running sandbox; the exec tests all target `sbx-1`. */
const SBX: DaytonaSandbox = { id: 'sbx-1', state: 'started' };

const CONFIG = {
	Image: 'ghcr.io/hezo-ai/agent-base@sha256:abc',
	HostConfig: { Memory: 2 * 1024 ** 3 },
};

describe('DaytonaEngine lifecycle', () => {
	it('builds from a one-line Dockerfile carrying the pinned image', async () => {
		// Daytona has no `image` field at all - a custom image arrives as
		// Dockerfile text it builds, and its cache is keyed on that text.
		const { api, rec } = fakeApi();
		await new DaytonaEngine(api).createContainer('hezo-p1', { ...CONFIG, HostConfig: {} });
		expect(rec.creates[0].dockerfileContent).toBe('FROM ghcr.io/hezo-ai/agent-base@sha256:abc\n');
	});

	it('pins a tagged image to its digest before building', async () => {
		// Daytona caches the build on a hash of the Dockerfile text, so a tag is
		// byte-identical forever and the provider would keep serving the snapshot
		// it first built - agents silently on an old toolchain.
		const digest = 'sha256:c571976834e5ad497e3393231a83dd7a949f9218622812ff998cabb1f699f627';
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(null, {
						status: 200,
						headers: new Headers({ 'docker-content-digest': digest }),
					}),
			),
		);
		const { api, rec } = fakeApi();
		await new DaytonaEngine(api).createContainer('hezo-p1', {
			Image: 'ghcr.io/hezo-ai/agent-base:latest',
			HostConfig: {},
		});
		expect(rec.creates[0].dockerfileContent).toBe(`FROM ghcr.io/hezo-ai/agent-base@${digest}\n`);
	});

	it('disables auto-delete so a stopped sandbox survives to be resumed', async () => {
		// Daytona's default deletes a stopped sandbox. Suspend-and-resume is the
		// whole lifecycle, so losing the filesystem on stop would break it.
		const { api, rec } = fakeApi();
		await new DaytonaEngine(api).createContainer('hezo-p1', CONFIG);
		expect(rec.creates[0].autoDeleteInterval).toBeLessThan(0);
		expect(rec.creates[0].autoStopInterval).toBeGreaterThan(0);
	});

	it('converts the cgroup byte cap into whole GB', async () => {
		const { api, rec } = fakeApi();
		await new DaytonaEngine(api).createContainer('hezo-p1', CONFIG);
		expect(rec.creates[0].memory).toBe(2);
	});

	it('does not re-start a sandbox that create already started', async () => {
		// Docker's create leaves the container stopped; Daytona's does not, and
		// starting a started sandbox is an error there.
		const { api, rec } = fakeApi();
		const engine = new DaytonaEngine(api);
		const { Id } = await engine.createContainer('hezo-p1', CONFIG);
		await engine.startContainer(Id);
		expect(rec.started).toEqual([]);
	});

	it('starts a stopped sandbox', async () => {
		const { api, rec } = fakeApi({}, [{ id: 'sbx-9', state: 'stopped' }]);
		await new DaytonaEngine(api).startContainer('sbx-9');
		expect(rec.started).toEqual(['sbx-9']);
	});
});

describe('DaytonaEngine inspect', () => {
	const cases: Array<[string, string, boolean]> = [
		['started', 'running', true],
		['stopped', 'exited', false],
		['archived', 'exited', false],
		['error', 'exited', false],
		['build_failed', 'exited', false],
		// Transitional states must NOT read as dead - a sandbox mid-start would
		// otherwise be failed out from under the run that just asked for it.
		['starting', 'created', false],
		['pulling_snapshot', 'created', false],
		['restoring', 'created', false],
		['some-future-state', 'created', false],
	];

	for (const [state, status, running] of cases) {
		it(`maps ${state} to ${status}`, async () => {
			const { api } = fakeApi({}, [{ id: 'sbx-1', state }]);
			const info = await new DaytonaEngine(api).inspectContainer('sbx-1');
			expect(info?.State.Status).toBe(status);
			expect(info?.State.Running).toBe(running);
		});
	}

	it('reports a nonzero exit code only for a failed sandbox', async () => {
		const { api } = fakeApi({}, [
			{ id: 'ok', state: 'stopped' },
			{ id: 'bad', state: 'error' },
		]);
		const engine = new DaytonaEngine(api);
		expect((await engine.inspectContainer('ok'))?.State.ExitCode).toBe(0);
		expect((await engine.inspectContainer('bad'))?.State.ExitCode).toBe(1);
	});

	it('recovers the image from a label, since Daytona forgets what it built', async () => {
		const { api } = fakeApi();
		const engine = new DaytonaEngine(api);
		const { Id } = await engine.createContainer('hezo-p1', CONFIG);
		expect((await engine.inspectContainer(Id))?.Config.Image).toBe(CONFIG.Image);
	});

	it('returns null for a sandbox that is gone', async () => {
		const { api } = fakeApi();
		expect(await new DaytonaEngine(api).inspectContainer('nope')).toBeNull();
	});

	it('finds a container by name prefix through the name label', async () => {
		const { api } = fakeApi();
		const engine = new DaytonaEngine(api);
		await engine.createContainer('hezo-project-alpha', CONFIG);
		expect(await engine.findContainerByNamePrefix('hezo-project-')).not.toBeNull();
		expect(await engine.findContainerByNamePrefix('hezo-other-')).toBeNull();
	});
});

describe('DaytonaEngine exec', () => {
	it('carries the exit code from start through to inspect', async () => {
		// Daytona has no exec handle, so the create/start/inspect triad is
		// reassembled inside the adapter; the exit code has to survive that.
		const { api } = fakeApi({ execute: async () => ({ exitCode: 42, output: 'out' }) }, [SBX]);
		const engine = new DaytonaEngine(api);
		const id = await engine.execCreate('sbx-1', {
			Cmd: ['false'],
			AttachStdout: true,
			AttachStderr: false,
		});
		await engine.execStart(id);
		expect((await engine.execInspect(id)).ExitCode).toBe(42);
	});

	it('streams through onChunk and retains nothing', async () => {
		const chunks: string[] = [];
		const { api } = fakeApi(
			{
				executeStreaming: async (_s, _c, onLine) => {
					await onLine('line-1\n');
					await onLine('line-2\n');
					return { exitCode: 0 };
				},
			},
			[SBX],
		);
		const engine = new DaytonaEngine(api);
		const id = await engine.execCreate('sbx-1', {
			Cmd: ['agent'],
			AttachStdout: true,
			AttachStderr: false,
		});
		const res = await engine.execStart(id, { onChunk: (c) => void chunks.push(c.text) });
		expect(chunks).toEqual(['line-1\n', 'line-2\n']);
		// An agent transcript reaches hundreds of MB; a streaming exec that
		// buffered would reintroduce exactly the cost onChunk exists to avoid.
		expect(res.stdout).toBe('');
	});

	it('recovers stderr separately, because Daytona merges the two streams', async () => {
		// Measured, not assumed: its response carries stdout/stderr fields but
		// both are always null. The split is load-bearing upstream - the agent
		// stream-json parser routes on it, and a git exec parses stdout for shas
		// while git writes progress to stderr.
		const { api } = fakeApi(
			{
				execute: async (_s, command) =>
					command.includes('tail -c')
						? { exitCode: 0, output: 'boom\n' }
						: { exitCode: 1, output: 'real-stdout\n' },
			},
			[SBX],
		);
		const engine = new DaytonaEngine(api);
		const id = await engine.execCreate('sbx-1', {
			Cmd: ['git', 'status'],
			AttachStdout: true,
			AttachStderr: true,
		});
		const res = await engine.execStart(id);
		expect(res.stdout).toBe('real-stdout\n');
		expect(res.stderr).toBe('boom\n');
	});

	it('does not drain stderr when the caller did not attach it', async () => {
		const { api, rec } = fakeApi({}, [SBX]);
		const engine = new DaytonaEngine(api);
		const id = await engine.execCreate('sbx-1', {
			Cmd: ['true'],
			AttachStdout: false,
			AttachStderr: false,
		});
		await engine.execStart(id);
		expect(rec.commands.filter((c) => c.includes('tail -c'))).toEqual([]);
	});

	it('survives a stderr drain that fails on a dead sandbox', async () => {
		// A sandbox that died mid-exec cannot be read back; losing the diagnostic
		// must not turn into a second failure on top of the first.
		const { api } = fakeApi(
			{
				execute: async (_s, command) => {
					if (command.includes('tail -c')) throw new Error('sandbox gone');
					return { exitCode: 3, output: 'partial' };
				},
			},
			[SBX],
		);
		const engine = new DaytonaEngine(api);
		const id = await engine.execCreate('sbx-1', {
			Cmd: ['agent'],
			AttachStdout: true,
			AttachStderr: true,
		});
		const res = await engine.execStart(id);
		expect(res.stdout).toBe('partial');
		expect(res.stderr).toBe('');
		expect((await engine.execInspect(id)).ExitCode).toBe(3);
	});

	it('passes the working directory through', async () => {
		let seen: string | undefined;
		const { api } = fakeApi(
			{
				execute: async (_s, _c, opts) => {
					seen = opts?.cwd;
					return { exitCode: 0, output: '' };
				},
			},
			[SBX],
		);
		const engine = new DaytonaEngine(api);
		const id = await engine.execCreate('sbx-1', {
			Cmd: ['git', 'log'],
			WorkingDir: '/worktrees/T-1/repo',
			AttachStdout: true,
			AttachStderr: false,
		});
		await engine.execStart(id);
		expect(seen).toBe('/worktrees/T-1/repo');
	});
});

describe('DaytonaEngine process management', () => {
	it('runs the same /proc scripts the Docker engine runs', async () => {
		// The scripts are runtime-agnostic and shared; only the transport differs.
		// Reimplementing them per engine is how the two backends drift apart.
		const { api, rec } = fakeApi({}, [{ id: 'sbx-1', state: 'started' }]);
		const engine = new DaytonaEngine(api);
		await engine.killRunProcesses('sbx-1', 'run-abc');
		expect(rec.commands[0]).toContain('HEZO_HEARTBEAT_RUN_ID=run-abc');
		expect(rec.commands[0]).toContain('/proc/[0-9]*/environ');
	});

	it('rejects a marker value that would need shell escaping', async () => {
		const { api } = fakeApi({}, [{ id: 'sbx-1', state: 'started' }]);
		await expect(
			new DaytonaEngine(api).killRunProcesses('sbx-1', 'a"; rm -rf /; #'),
		).rejects.toThrow(/unsafe env marker/);
	});

	it('parses the /proc scan into process records', async () => {
		const { api } = fakeApi(
			{ execute: async () => ({ exitCode: 0, output: '42\trun-1\t1\t90\thezo-ssh-bridge\n' }) },
			[{ id: 'sbx-1', state: 'started' }],
		);
		const procs = await new DaytonaEngine(api).listHezoProcesses('sbx-1');
		expect(procs).toEqual([
			{ pid: 42, runId: 'run-1', hasHezoSock: true, ageSecs: 90, cmdline: 'hezo-ssh-bridge' },
		]);
	});

	it('is a no-op on an empty pid list', async () => {
		const { api, rec } = fakeApi({}, [{ id: 'sbx-1', state: 'started' }]);
		await new DaytonaEngine(api).killPids('sbx-1', []);
		expect(rec.commands).toEqual([]);
	});

	it('rejects an unsafe pid', async () => {
		const { api } = fakeApi({}, [{ id: 'sbx-1', state: 'started' }]);
		await expect(new DaytonaEngine(api).killPids('sbx-1', [1])).rejects.toThrow(/unsafe pid/);
	});
});

describe('DaytonaEngine degradations', () => {
	it('reports no memory reading rather than zero when metrics are absent', async () => {
		// The caller treats null as "no reading this tick". Returning 0 would read
		// as a sandbox using no memory and defeat the cap enforcement entirely.
		const { api } = fakeApi();
		expect(await new DaytonaEngine(api).containerStats('sbx-1')).toBeNull();
	});

	it('reads the newest memory data point when a series exists', async () => {
		const { api } = fakeApi({
			getMetrics: async () =>
				new Map([
					['sandbox.memory.limit', 8e9],
					['sandbox.memory.usage', 1.5e9],
				]),
		});
		expect(await new DaytonaEngine(api).containerStats('sbx-1')).toEqual({
			usedBytes: 1.5e9,
			rawUsageBytes: 1.5e9,
		});
	});

	it('tolerates a metrics endpoint that errors', async () => {
		const { api } = fakeApi({
			getMetrics: async () => {
				throw new Error('metrics down');
			},
		});
		expect(await new DaytonaEngine(api).containerStats('sbx-1')).toBeNull();
	});

	it('has no container log stream, because PID 1 is sleep infinity', async () => {
		const { api } = fakeApi();
		expect(await new DaytonaEngine(api).containerLogs()).toBeNull();
	});

	it('reports the image as present so nothing attempts a meaningless pull', async () => {
		// Daytona builds from Dockerfile text and exposes no image store; the
		// build happens at sandbox create.
		const { api } = fakeApi();
		const engine = new DaytonaEngine(api);
		expect(await engine.imageExists()).toBe(true);
		await expect(engine.pullImage()).resolves.toBeUndefined();
		expect(await engine.inspectNetwork()).toBeNull();
	});
});
