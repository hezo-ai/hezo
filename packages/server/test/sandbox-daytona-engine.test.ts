import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	type CreateSandboxSpec,
	type DaytonaApi,
	DaytonaApiError,
	type DaytonaFileEntry,
	type DaytonaSandbox,
} from '../src/services/sandbox/daytona/client';
import { bindMountDirs, DaytonaEngine } from '../src/services/sandbox/daytona/engine';
import { clearImageDigestCache } from '../src/services/sandbox/image-ref';

interface Recorded {
	creates: CreateSandboxSpec[];
	commands: string[];
	started: string[];
	stopped: string[];
	destroyed: string[];
	/** Launch lines handed to `openPty`, and anything written to the channel after. */
	ptyLaunches: string[];
	ptyWrites: Uint8Array[];
}

/**
 * A complete `DaytonaApi`, not a partial object cast into place - a stub that
 * omits a method only fails when production happens to call it.
 */
function fakeApi(
	overrides: Partial<DaytonaApi> = {},
	seed: DaytonaSandbox[] = [],
): { api: DaytonaApi; rec: Recorded; sandboxes: Map<string, DaytonaSandbox> } {
	const rec: Recorded = {
		creates: [],
		commands: [],
		started: [],
		stopped: [],
		destroyed: [],
		ptyLaunches: [],
		ptyWrites: [],
	};
	const sandboxes = new Map(seed.map((s) => [s.id, s]));
	// The file half is a real (if flat) tree rather than five no-ops: a write the
	// fake forgets would let a read-back assertion pass against nothing.
	const files = new Map<string, { content: Uint8Array; mode: number; isDir: boolean }>();
	let n = 0;
	// Object.assign rather than a `...overrides` spread: spreading a Partial
	// widens every key it names to `T | undefined`, which quietly turns the
	// complete fake this claims to be back into a partial one.
	const api: DaytonaApi = Object.assign<DaytonaApi, Partial<DaytonaApi>>(
		{
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
			openPty: async (_s, _sessionId, launch) => {
				rec.ptyLaunches.push(launch);
				return {
					send: (data) => rec.ptyWrites.push(data),
					onData: () => {},
					onClose: () => {},
					close: () => {},
				};
			},
			execute: async (_s, command) => {
				rec.commands.push(command);
				return { exitCode: 0, output: '' };
			},
			executeStreaming: async (_s, command) => {
				rec.commands.push(command);
				return { exitCode: 0 };
			},
			listFiles: async (_s, path) => {
				const prefix = path.endsWith('/') ? path : `${path}/`;
				const out: DaytonaFileEntry[] = [];
				for (const [p, f] of files) {
					if (!p.startsWith(prefix)) continue;
					const rest = p.slice(prefix.length);
					if (rest === '' || rest.includes('/')) continue;
					out.push({
						name: rest,
						path: p,
						size: f.content.byteLength,
						isDir: f.isDir,
						permissions: f.mode.toString(8).padStart(4, '0'),
					});
				}
				return out;
			},
			// A directory has no content to download, matching the live API where
			// downloading one is a 400 rather than a "no" - which is why `exists` is
			// built on `statFile` instead.
			downloadFile: async (_s, path) => {
				const f = files.get(path);
				return f && !f.isDir ? f.content : null;
			},
			statFile: async (_s, path) => {
				const f = files.get(path);
				if (!f) return null;
				return {
					name: path.slice(path.lastIndexOf('/') + 1),
					path,
					size: f.content.byteLength,
					isDir: f.isDir,
					permissions: f.mode.toString(8).padStart(4, '0'),
				};
			},
			uploadFile: async (_s, path, content, mode) => {
				files.set(path, { content, mode: mode ?? 0o644, isDir: false });
			},
			createFolder: async (_s, path, mode) => {
				files.set(path, { content: new Uint8Array(), mode: mode ?? 0o755, isDir: true });
			},
			deleteFile: async (_s, path, opts) => {
				// Without `recursive` the live API refuses a non-empty directory
				// outright rather than deleting what it can, so the fake refuses too -
				// a fake that always succeeded would pass a contract production does
				// not offer, which is how the silent credential scrub shipped.
				const entry = files.get(path);
				const prefix = `${path}/`;
				const children = [...files.keys()].filter((p) => p.startsWith(prefix));
				if (entry?.isDir && children.length > 0 && !opts?.recursive) {
					throw new Error('bad request: cannot delete directory without recursive flag');
				}
				files.delete(path);
				if (opts?.recursive) for (const child of children) files.delete(child);
			},
		},
		overrides,
	);
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

	it('converts the working-set ceiling into whole GB', async () => {
		const { api, rec } = fakeApi();
		await new DaytonaEngine(api).createContainer('hezo-p1', CONFIG);
		expect(rec.creates[0].memory).toBe(2);
	});

	it('rounds a fractional ceiling up, never down', async () => {
		// A 1.5 GB ceiling provisioned as 1 GB is a container that OOMs below the
		// limit its run was sized against - which reads as an agent failure.
		const { api, rec } = fakeApi();
		await new DaytonaEngine(api).createContainer('hezo-p1', {
			...CONFIG,
			HostConfig: { Memory: 1.5 * 1024 ** 3 },
		});
		expect(rec.creates[0].memory).toBe(2);
	});

	it('accepts a project set to exactly the provider ceiling', async () => {
		// The boundary case, and the reason the cgroup headroom moved into the
		// Docker adapter. With it folded into the caller's figure, 8 GB - the value
		// the provider's own docs advertise as the maximum - arrived here as 8.5,
		// rounded to 9, and was refused with a message telling the operator to lower
		// a limit they had set to exactly the documented maximum, quoting a number
		// they never entered.
		const { api, rec } = fakeApi();
		await new DaytonaEngine(api).createContainer('hezo-p1', {
			...CONFIG,
			HostConfig: { Memory: 8 * 1024 ** 3 },
		});
		expect(rec.creates[0].memory).toBe(8);
	});

	it('refuses a ceiling above what the provider can allocate, rather than shrinking it', async () => {
		const { api } = fakeApi();
		await expect(
			new DaytonaEngine(api).createContainer('hezo-p1', {
				...CONFIG,
				HostConfig: { Memory: 12 * 1024 ** 3 },
			}),
		).rejects.toThrow(/at most 8 GB/);
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

/**
 * Docker brings a bind's target into existence as a side effect of create. A
 * managed sandbox has no binds, so the adapter has to meet the same
 * postcondition - or the chown that follows, and every clone and worktree after
 * it, fails on a missing path on one backend and nowhere else.
 */
describe('bindMountDirs', () => {
	let root: string;
	let dir: string;
	let file: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'hezo-binds-'));
		dir = join(root, 'previews');
		mkdirSync(dir);
		file = join(root, 'hezo-egress.crt');
		writeFileSync(file, 'cert');
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('creates a dotted directory target rather than its parent', async () => {
		// The bug this exists for. Classification used to ask whether the *container*
		// path contained a dot, which is true of any dotted directory - so
		// `/workspace/.previews` was read as a file and `/workspace` was created in
		// its place, leaving the one target that had to be created the one that
		// never was.
		expect([...bindMountDirs([`${dir}:/workspace/.previews:rw`])]).toEqual([
			'/workspace/.previews',
		]);
	});

	it('creates the parent of a file mount, since the file itself is the mount', async () => {
		// The egress CA is a single file; its directory is what must exist.
		expect([...bindMountDirs([`${file}:/usr/local/share/ca-certificates/hezo.crt:ro`])]).toEqual([
			'/usr/local/share/ca-certificates',
		]);
	});

	it('reads the host side, not the container path, so an extensionless file still resolves', async () => {
		const plain = join(root, 'plainfile');
		writeFileSync(plain, 'x');
		expect([...bindMountDirs([`${plain}:/etc/hezo/marker:ro`])]).toEqual(['/etc/hezo']);
	});

	it('treats an unreadable host path as a directory, which is what Docker does', async () => {
		expect([...bindMountDirs([`${join(root, 'gone')}:/workspace:rw`])]).toEqual(['/workspace']);
	});

	it('handles the production bind list', async () => {
		const dirs = bindMountDirs([
			`${root}:/workspace:rw`,
			`${dir}:/workspace/.previews:rw`,
			`${file}:/usr/local/share/ca-certificates/hezo.crt:ro`,
		]);
		expect([...dirs].sort()).toEqual([
			'/usr/local/share/ca-certificates',
			'/workspace',
			'/workspace/.previews',
		]);
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
	it('reports no memory reading rather than zero when the cgroup cannot be read', async () => {
		// The caller treats null as "no reading this tick". Returning 0 would read
		// as a sandbox using no memory and defeat the cap enforcement entirely.
		const { api } = fakeApi();
		expect(await new DaytonaEngine(api).containerStats('sbx-1')).toBeNull();
	});

	it('measures disk with the shared df script, in bytes', async () => {
		// The same script the Docker engine runs - only the transport differs. A
		// second copy per adapter is how the two backends silently drift apart.
		const { api, rec } = fakeApi(
			{ execute: async (_s, command) => ({ exitCode: 0, output: '3072\n' }) },
			[SBX],
		);
		expect(await new DaytonaEngine(api).diskUsedBytes('sbx-1', '/workspace')).toBe(3 * 1024 * 1024);
		void rec;
	});

	it('reports no disk reading rather than zero when df cannot answer', async () => {
		// Same reasoning as the memory reading above: 0 would mean "this container
		// is empty" and make the pool reuse a container that is actually full.
		const { api } = fakeApi(
			{
				execute: async () => {
					throw new Error('sandbox gone');
				},
			},
			[SBX],
		);
		expect(await new DaytonaEngine(api).diskUsedBytes('sbx-1', '/workspace')).toBeNull();
	});

	it('measures memory with the shared cgroup script, as a working set', async () => {
		// The same arithmetic the Docker engine applies to the daemon's figures -
		// total charge less reclaimable page cache - because one threshold is
		// compared against both and they must be the same quantity.
		const ran: string[] = [];
		const { api } = fakeApi(
			{
				execute: async (_s, command) => {
					ran.push(command);
					return { exitCode: 0, output: '2147483648 1073741824\n' };
				},
			},
			[SBX],
		);
		expect(await new DaytonaEngine(api).containerStats('sbx-1')).toEqual({
			usedBytes: 1024 ** 3,
			rawUsageBytes: 2 * 1024 ** 3,
		});
		// Read from the sandbox rather than from the provider's telemetry API, which
		// 403s permanently on an ordinary account and left this backend with no
		// memory enforcement at all.
		expect(ran.some((c) => c.includes('memory.current'))).toBe(true);
	});

	it('reports no memory reading when the script says nothing', async () => {
		// Which is what it does in an unlimited cgroup: the reading there would be
		// the host's, not this container's, and enforcing against it would stop the
		// container on the first poll.
		const { api } = fakeApi({ execute: async () => ({ exitCode: 0, output: '' }) }, [SBX]);
		expect(await new DaytonaEngine(api).containerStats('sbx-1')).toBeNull();
	});

	it('tolerates an exec that cannot run at all', async () => {
		const { api } = fakeApi(
			{
				execute: async () => {
					throw new Error('sandbox gone');
				},
			},
			[SBX],
		);
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

/**
 * Daytona's lifecycle calls return when the transition has been **accepted**,
 * not when it has happened - create answers `creating`, stop answers `stopping`.
 * Docker's do not behave that way, so absorbing it is the adapter's job, and
 * leaking it upward produced two real failures against the live API: a hard 409
 * ("Sandbox state change in progress") on stop-then-start, and a just-created
 * sandbox reading `Running: false` straight into the container-death path.
 */
describe('DaytonaEngine settles a transition before returning', () => {
	/**
	 * An API whose state machine takes `steps` polls to reach its resting state,
	 * the way the real one does.
	 */
	function laggyApi(opts: {
		createStates?: string[];
		stopStates?: string[];
		startStates?: string[];
	}): { api: DaytonaApi; polls: () => number } {
		const queue = {
			create: [...(opts.createStates ?? [])],
			stop: [...(opts.stopStates ?? [])],
			start: [...(opts.startStates ?? [])],
		};
		let active: 'create' | 'stop' | 'start' = 'create';
		let polls = 0;
		const sandbox: DaytonaSandbox = {
			id: 'sbx-lag',
			state: 'started',
			labels: {},
			toolboxProxyUrl: 'https://proxy.test/toolbox',
		};
		const { api } = fakeApi(
			{
				createSandbox: async () => {
					active = 'create';
					sandbox.state = queue.create.length > 0 ? 'creating' : 'started';
					return sandbox;
				},
				getSandbox: async () => {
					polls += 1;
					const next = queue[active].shift();
					if (next) sandbox.state = next;
					return sandbox;
				},
				stop: async () => {
					active = 'stop';
					sandbox.state = 'stopping';
				},
				start: async () => {
					active = 'start';
					sandbox.state = queue.start.length > 0 ? 'starting' : 'started';
				},
			},
			[sandbox],
		);
		return { api, polls: () => polls };
	}

	it('waits for a created sandbox to leave `creating`', async () => {
		const { api } = laggyApi({ createStates: ['creating', 'creating', 'started'] });
		const engine = new DaytonaEngine(api);
		const { Id } = await engine.createContainer('c', {
			Image: 'img',
			HostConfig: {},
		} as never);
		// The caller's very first inspect must not read a coming-up sandbox as dead.
		expect((await engine.inspectContainer(Id))?.State.Running).toBe(true);
	});

	it('waits out a `stopping` sandbox instead of starting into a 409', async () => {
		// The live API rejects a start while the stop is still in flight, which is
		// exactly what the chat's resume path and the pool's resume rung do.
		const { api } = laggyApi({ stopStates: ['stopping', 'stopped'], startStates: ['started'] });
		const engine = new DaytonaEngine(api);
		await engine.stopContainer('sbx-lag');
		// Settled on the way out: a suspended container must not read as dead.
		expect((await engine.inspectContainer('sbx-lag'))?.State.Running).toBe(false);
		await engine.startContainer('sbx-lag');
		expect((await engine.inspectContainer('sbx-lag'))?.State.Running).toBe(true);
	});

	it('does not call stop on a sandbox that is already stopped', async () => {
		// The provider stops sandboxes on its own idle interval, so by the time
		// Hezo's idle-stop runs the sandbox is routinely already at rest. Asking it
		// to stop then answers `400 Sandbox is not in a stoppable state`, which
		// reached the operator as a red banner on a container behaving correctly.
		const { api, rec } = fakeApi({}, [
			{ id: 'sbx-down', state: 'stopped', labels: {}, toolboxProxyUrl: 'https://p/toolbox' },
		]);
		await new DaytonaEngine(api).stopContainer('sbx-down');
		expect(rec.stopped).toEqual([]);
	});

	it('tolerates the provider stopping a sandbox underneath the stop call', async () => {
		// The same answer, but from the race the check above cannot close: the
		// provider's auto-stop lands between reading the state and issuing the
		// stop. Tolerated only because the sandbox is confirmed at rest afterwards.
		let state = 'started';
		const { api } = fakeApi(
			{
				getSandbox: async () => ({
					id: 'sbx-race',
					state,
					labels: {},
					toolboxProxyUrl: 'https://p/toolbox',
				}),
				stop: async () => {
					state = 'stopped';
					throw new DaytonaApiError(
						'Daytona stop failed (400): Sandbox is not in a stoppable state',
						400,
						'',
					);
				},
			},
			[{ id: 'sbx-race', state: 'started', labels: {}, toolboxProxyUrl: 'https://p/toolbox' }],
		);
		await expect(new DaytonaEngine(api).stopContainer('sbx-race')).resolves.toBeUndefined();
	});

	it('still surfaces a stop rejection when the sandbox is left running', async () => {
		// The other side of the same catch: a 400 from a sandbox that is still up
		// is a real failure, and swallowing it would park a running container in
		// the pool's books as stopped.
		const { api } = fakeApi(
			{
				stop: async () => {
					throw new DaytonaApiError('Daytona stop failed (400): something else', 400, '');
				},
			},
			[{ id: 'sbx-up2', state: 'started', labels: {}, toolboxProxyUrl: 'https://p/toolbox' }],
		);
		await expect(new DaytonaEngine(api).stopContainer('sbx-up2')).rejects.toThrow(/400/);
	});

	it('does not call start on a sandbox that is already started', async () => {
		const { api, rec } = fakeApi({}, [
			{ id: 'sbx-up', state: 'started', labels: {}, toolboxProxyUrl: 'https://p/toolbox' },
		]);
		await new DaytonaEngine(api).startContainer('sbx-up');
		expect(rec.started).toEqual([]);
	});

	it('treats an unknown state as transitional, not as settled', async () => {
		// The deliberate direction of the unknown case. A new *transitional* state
		// we proceeded through would resurface as the 409 this exists to remove,
		// whereas a new *resting* state costs one bounded wait and logs itself,
		// which is how we would find out about it. Asserted as "does not return
		// immediately" - the bound itself is 180s and not worth burning in a unit
		// test.
		const sandbox: DaytonaSandbox = {
			id: 'sbx-weird',
			state: 'some_new_state',
			labels: {},
			toolboxProxyUrl: 'https://proxy.test/toolbox',
		};
		const { api } = fakeApi({ getSandbox: async () => sandbox }, [sandbox]);
		const engine = new DaytonaEngine(api);
		await expect(
			Promise.race([
				engine.stopContainer('sbx-weird').then(() => 'returned'),
				new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300)),
			]),
		).resolves.toBe('still waiting');
	});
});

/**
 * The file contract, where this backend diverged from the host implementation in
 * two ways that both failed quietly.
 */
describe('DaytonaEngine files', () => {
	const sandbox: DaytonaSandbox = {
		id: 'sbx-files',
		state: 'started',
		labels: {},
		toolboxProxyUrl: 'https://proxy.test/toolbox',
	};

	it('scrubs a non-empty directory rather than leaving it in place', async () => {
		// The per-run runtime home holds the provider credential, so `removeDir` is
		// a scrub and not tidying. The API refuses a non-empty directory without a
		// recursive flag, and the failure was swallowed as best-effort - so on this
		// backend the credential stayed on the provider's disk for the rest of the
		// container's life while the cleanup step reported success.
		const { api } = fakeApi({}, [sandbox]);
		const engine = new DaytonaEngine(api);
		const files = engine.files('sbx-files', '/run');

		await files.write('home/.config/creds.json', '{"token":"x"}', { mode: 0o600, dirMode: 0o711 });
		expect(await files.exists('home/.config/creds.json')).toBe(true);

		await files.removeDir('home');
		expect(await files.exists('home/.config/creds.json')).toBe(false);
		expect(await files.exists('home')).toBe(false);
	});

	it('answers exists for a directory instead of throwing', async () => {
		// Built on a download, a directory was a 400 rather than a "yes" - a
		// divergence from the host implementation, which simply stats the path.
		const { api } = fakeApi({}, [sandbox]);
		const engine = new DaytonaEngine(api);
		const files = engine.files('sbx-files', '/run');

		await files.mkdir('somedir');
		expect(await files.exists('somedir')).toBe(true);
		expect(await files.exists('nothing-here')).toBe(false);
	});

	it('reports a size without transferring the file, and null for a directory', async () => {
		const { api } = fakeApi({}, [sandbox]);
		const engine = new DaytonaEngine(api);
		const files = engine.files('sbx-files', '/run');

		await files.write('payload.bin', 'abcde');
		expect(await files.size('payload.bin')).toBe(5);
		await files.mkdir('adir');
		expect(await files.size('adir')).toBeNull();
		expect(await files.size('missing')).toBeNull();
	});
});

describe('DaytonaEngine byte channel (the tunnel transport)', () => {
	// A PTY starts a login shell, so anything the shell emits around accepting a
	// command lands on the channel ahead of the command's own first byte - and
	// the tunnel's decoder reads whatever arrives first as
	// `[u8 type][u32 streamId][u32 len]`. Against the live API this was fatal
	// rather than cosmetic: the shell's echo of `stty raw -echo` decoded as a
	// frame of length 1918990112 ("raw " read as a u32), the mux closed the
	// channel on the spot, and every agent run on Daytona then failed with the
	// Hezo MCP server unreachable. These assertions pin the shape that fixed it.

	it('launches the command with the PTY rather than typing it in afterwards', async () => {
		const { api, rec } = fakeApi({}, [SBX]);
		await new DaytonaEngine(api).openExecChannel('sbx-1', {
			Cmd: ['hezo-tunnel', '/workspace/.hezo/tunnel.json'],
			User: 'node',
			AttachStdout: true,
			AttachStderr: true,
		});
		expect(rec.ptyLaunches).toHaveLength(1);
		expect(rec.ptyLaunches[0]).toContain('hezo-tunnel');
		// Nothing is written to the channel by opening it. A command typed in
		// after the fact is echoed by the shell, and that echo is the corruption.
		expect(rec.ptyWrites).toEqual([]);
	});

	it('deprivileges the launched command the same way a normal exec does', async () => {
		const { api, rec } = fakeApi({}, [SBX]);
		await new DaytonaEngine(api).openExecChannel('sbx-1', {
			Cmd: ['hezo-tunnel', '/cfg.json'],
			User: 'node',
			AttachStdout: true,
			AttachStderr: true,
		});
		// Daytona execs as root, so the tunnel client would run as root without
		// this - a root-owned process in a container the agent otherwise owns.
		expect(rec.ptyLaunches[0]).toMatch(/runuser.+-u.+node/);
		// And its stderr goes to a file, not down the channel: a diagnostic from
		// `runuser` interleaved into the frame stream corrupts it just as the
		// shell's own echo did.
		expect(rec.ptyLaunches[0]).toMatch(/2>.*\.err/);
	});

	it('writes only what the caller writes, once the channel is open', async () => {
		const { api, rec } = fakeApi({}, [SBX]);
		const channel = await new DaytonaEngine(api).openExecChannel('sbx-1', {
			Cmd: ['hezo-tunnel', '/cfg.json'],
			AttachStdout: true,
			AttachStderr: true,
		});
		channel.write(new Uint8Array([1, 2, 3]));
		expect(rec.ptyWrites).toEqual([new Uint8Array([1, 2, 3])]);
	});

	it('closing the channel is what must terminate the in-container process', async () => {
		// On Docker, closing the hijacked exec kills the process. On Daytona the
		// WebSocket close does neither - measured: a process launched on a PTY was
		// still listening after the socket closed, and the session still read
		// `active: true`. Only deleting the session ends it, so `close()` has to do
		// more than close the socket. The leak is not cosmetic: the tunnel client
		// holds the run's three loopback ports, and a pooled container serves many
		// runs in sequence, so the next run's client dies with EADDRINUSE and that
		// run loses MCP and egress entirely.
		let closes = 0;
		const { api } = fakeApi(
			{
				openPty: async () => ({
					send: () => {},
					onData: () => {},
					onClose: () => {},
					close: () => {
						closes += 1;
					},
				}),
			},
			[SBX],
		);
		const channel = await new DaytonaEngine(api).openExecChannel('sbx-1', {
			Cmd: ['hezo-tunnel', '/cfg.json'],
			AttachStdout: true,
			AttachStderr: true,
		});
		channel.close();
		expect(closes).toBe(1);
	});
});

/**
 * A managed backend pulls its image from a registry, so an image reference only
 * a local Docker daemon can resolve is unusable there - and the combination that
 * produces one is ordinary: a dev server (which builds agent-base into the local
 * image store) switched onto a managed backend.
 */
describe('DaytonaEngine image reference', () => {
	it('refuses the local-build sentinel instead of letting the provider fail the build', async () => {
		// Left to Daytona this surfaces as `build_failed: ghcr.io/... not found`
		// against a Docker Hub repository the operator never typed, several steps
		// from the cause. Measured: that is exactly what a sandbox created from an
		// unresolvable ref reports.
		const { api, rec } = fakeApi();
		await expect(
			new DaytonaEngine(api).createContainer('hezo-p1', {
				...CONFIG,
				Image: 'hezo/agent-base:latest',
			}),
		).rejects.toThrow(/local-build reference/);
		// And nothing was provisioned, so a refused image costs no sandbox.
		expect(rec.creates).toEqual([]);
	});

	it('names the override that fixes it', async () => {
		const { api } = fakeApi();
		const err = await new DaytonaEngine(api)
			.createContainer('hezo-p1', { ...CONFIG, Image: 'hezo/agent-base:latest' })
			.catch((e) => e);
		expect(err.message).toContain('containers.agentBaseImage');
	});

	it('accepts any published reference, including a project’s own', async () => {
		// The check is narrow on purpose: it refuses one known-unpullable value, not
		// every reference without a registry host - `node:24-slim` has no host
		// either and is a perfectly good image a project may legitimately name.
		//
		// Asserted as "was accepted and provisioned", not on the exact `FROM` text:
		// whether the ref reaches Daytona as a tag or digest-pinned depends on
		// whether the registry answered, which is a different property (covered
		// above) and not one this test should be coupled to.
		const { api, rec } = fakeApi();
		const engine = new DaytonaEngine(api);
		await engine.createContainer('hezo-p1', { ...CONFIG, Image: 'node:24-slim' });
		await engine.createContainer('hezo-p2', { ...CONFIG, Image: 'ghcr.io/acme/custom:1' });
		expect(rec.creates).toHaveLength(2);
		expect(rec.creates[0].dockerfileContent).toContain('node');
		expect(rec.creates[1].dockerfileContent).toContain('ghcr.io/acme/custom');
	});
});

describe('a full provider account', () => {
	it('explains the quota refusal instead of pasting the provider JSON', async () => {
		// This reached the operator verbatim in a task comment - a JSON blob where a
		// sentence was needed - and it is not a Hezo failure at all: the account is
		// full. Naming the lever matters more than naming the error, because how
		// many sandboxes fit is quota / disk-per-container, and that is a setting.
		const { api } = fakeApi({
			createSandbox: async () => {
				throw new DaytonaApiError(
					'Daytona POST /sandbox failed (400): ...',
					400,
					JSON.stringify({
						statusCode: 400,
						message: 'Total disk limit exceeded. Maximum allowed: 30GiB',
					}),
				);
			},
		});
		const engine = new DaytonaEngine(api);

		await expect(
			engine.createContainer('c', {
				Image: 'ghcr.io/hezo-ai/agent-base:pinned',
				HostConfig: { Memory: 2 * 1024 ** 3 },
			} as never),
		).rejects.toThrow(/no capacity left .* Total disk limit exceeded/s);
	});

	it('leaves an unrelated 400 alone', async () => {
		// Only the body distinguishes them - the status is a plain 400 shared with
		// every other bad request - so a broad match here would relabel real bugs.
		const { api } = fakeApi({
			createSandbox: async () => {
				throw new DaytonaApiError('Daytona POST /sandbox failed (400): ...', 400, 'bad image ref');
			},
		});
		const engine = new DaytonaEngine(api);

		await expect(
			engine.createContainer('c', {
				Image: 'ghcr.io/hezo-ai/agent-base:pinned',
				HostConfig: { Memory: 2 * 1024 ** 3 },
			} as never),
		).rejects.toThrow(/bad image ref|400/);
	});
});

describe('host setup', () => {
	it('does nothing, because a managed sandbox has no host state', async () => {
		// The other half of removing startup's `instanceof DockerClient` branches:
		// every backend has to answer `prepareHost`, and "nothing to prepare" is a
		// real answer rather than a reason for the caller to check who it is talking
		// to. A sandbox is built from Dockerfile text on the provider's machines and
		// has no binds, so there is no image store or mount to touch here.
		const { api, rec } = fakeApi();
		const engine = new DaytonaEngine(api);

		await expect(engine.prepareHost({ dataDir: '/nonexistent' })).resolves.toBeUndefined();

		expect(rec.creates).toEqual([]);
		expect(rec.started).toEqual([]);
		expect(rec.destroyed).toEqual([]);
	});
});
