/**
 * The Daytona adapter driven against the **live API**.
 *
 * Everything else in the Daytona test set uses a fake `DaytonaApi`, which proves
 * the adapter's own logic (command rendering, state mapping, exit-code
 * propagation) but says nothing about whether the provider still behaves the way
 * it did when the adapter was written. Several of the facts this adapter encodes
 * contradicted Daytona's own documentation - there is no `image` field on create,
 * `stdout`/`stderr` come back merged, a per-exec `user` is accepted and silently
 * ignored - so the only way to know they still hold is to ask the real API.
 *
 * **Opt-in and self-skipping.** It needs a real key and creates a billable
 * sandbox, so it cannot run in CI. Run it by hand before shipping a change to
 * `services/sandbox/daytona/`:
 *
 *   HEZO_DAYTONA_API_KEY=dtn_... bunx vitest run test/sandbox-daytona-live.test.ts
 *
 * Every assertion is written so a failure names the provider behaviour that
 * moved, not just the expectation that broke.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaytonaClient } from '../src/services/sandbox/daytona/client';
import { dockerSandboxHandle } from '../src/services/sandbox/handle';
import { openSandboxBackend } from '../src/services/sandbox/open';
import { INSTANCE_LABEL, reapOrphanedContainers } from '../src/services/sandbox/orphan-reaper';
import type { ContainerEngine, ExecLogChunk } from '../src/services/sandbox/types';

const apiKey = process.env.HEZO_DAYTONA_API_KEY;
const IMAGE = process.env.HEZO_AGENT_IMAGE ?? 'ghcr.io/hezo-ai/agent-base:latest';
const RUN_USER = { name: 'node', uid: 1000, gid: 1000 } as const;

// One sandbox for the whole file: a cold create is ~30s and each one is billed.
const TIMEOUT = 300_000;

describe.skipIf(!apiKey)('Daytona adapter — live API', () => {
	let engine: ContainerEngine;
	let info: unknown;
	let containerId: string;
	const instanceId = `hezo-live-${Math.random().toString(36).slice(2, 10)}`;

	// Every production caller sets these explicitly (see container-user.ts,
	// mcp-installer.ts, handle.ts), matching Docker, where an exec created without
	// AttachStdout genuinely returns no stdout.
	const runAs = async (cmd: string[], user: 'root' | 'node' = 'root') => {
		const execId = await engine.execCreate(containerId, {
			Cmd: cmd,
			User: user,
			AttachStdout: true,
			AttachStderr: true,
		});
		return engine.execStart(execId);
	};

	beforeAll(async () => {
		const opened = await openSandboxBackend({
			backend: 'daytona',
			daytonaApiKey: apiKey,
			daytonaApiUrl: process.env.HEZO_DAYTONA_API_URL,
		});
		engine = opened.engine;
		info = opened.info;
		const created = await engine.createContainer(`hezo-live-${instanceId}`, {
			Image: IMAGE,
			Env: ['HEZO_LIVE_CHECK=1'],
			Labels: { [INSTANCE_LABEL]: instanceId },
			HostConfig: { Memory: 2 * 1024 ** 3 },
		});
		containerId = created.Id;
	}, TIMEOUT);

	afterAll(async () => {
		if (containerId) await engine.removeContainer(containerId).catch(() => undefined);
	}, TIMEOUT);

	it('opens the backend and reports it without leaking the key', () => {
		// `info` is served on the settings endpoint, so a key that reached it would
		// be an exposure, not a cosmetic issue.
		const text = JSON.stringify(info);
		expect(text).not.toContain(apiKey);
		expect(text).not.toContain((apiKey as string).slice(0, 12));
	});

	it('creates a sandbox that is already running', async () => {
		// Unlike Docker, create starts it - which is why startContainer has to check
		// the state first rather than calling start unconditionally.
		const inspected = await engine.inspectContainer(containerId);
		expect(inspected?.State.Running).toBe(true);
	});

	it('reports the requested image rather than the resolved digest', async () => {
		// The digest pin is a cache-correctness device; the question
		// `inspectContainer` answers must stay the same one Docker answers.
		const inspected = await engine.inspectContainer(containerId);
		expect(inspected?.Config.Image).toBe(IMAGE);
	});

	it(
		'propagates a non-zero exit code and separates stdout from stderr',
		async () => {
			// The split is load-bearing: the stream-json parser routes on it, and the
			// git execs parse stdout for shas. Daytona merges the two on the wire, so
			// this is really testing the adapter's stderr-to-file recovery.
			const handle = dockerSandboxHandle(engine, containerId, RUN_USER);
			const chunks: ExecLogChunk[] = [];
			const outcome = await handle.exec({
				cmd: ['sh', '-c', 'echo to-stdout; echo to-stderr >&2; exit 7'],
				env: [],
				onChunk: async (c) => {
					chunks.push(c);
				},
			});
			expect(outcome.exitCode).toBe(7);
			const text = (stream: 'stdout' | 'stderr') =>
				chunks
					.filter((c) => c.stream === stream)
					.map((c) => c.text)
					.join('');
			expect(text('stdout')).toContain('to-stdout');
			expect(text('stderr')).toContain('to-stderr');
			expect(text('stdout')).not.toContain('to-stderr');
		},
		TIMEOUT,
	);

	it(
		'renders elevation as a flag, deprivileging for an unelevated exec',
		async () => {
			// The inverse of Docker: Daytona execs as root, so it is deprivileging that
			// has to be rendered. Had this shipped the other way round, every agent exec
			// would have run as root and left root-owned files in the worktree.
			expect((await runAs(['id', '-un'], 'root')).stdout.trim()).toBe('root');
			expect((await runAs(['id', '-un'], 'node')).stdout.trim()).toBe('node');
		},
		TIMEOUT,
	);

	it(
		'passes env from create and from the exec',
		async () => {
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'echo "$HEZO_LIVE_CHECK/$FROM_EXEC"'],
				Env: ['FROM_EXEC=yes'],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			expect((await engine.execStart(execId)).stdout.trim()).toBe('1/yes');
		},
		TIMEOUT,
	);

	it(
		'runs the shared /proc scripts, finding and killing a marked process',
		async () => {
			// Runtime-agnostic logic is shared between the engines: both run the
			// identical script from sandbox/proc-scripts.ts and only the transport
			// differs. A second copy is how the two backends drift apart.
			await runAs([
				'sh',
				'-c',
				'HEZO_HEARTBEAT_RUN_ID=live-marker nohup sleep 300 >/dev/null 2>&1 &',
			]);
			const before = await engine.listHezoProcesses(containerId);
			expect(before.some((p) => p.cmdline.includes('sleep'))).toBe(true);

			await engine.killProcessesByEnvMarker(containerId, 'HEZO_HEARTBEAT_RUN_ID', 'live-marker');
			const after = await engine.listHezoProcesses(containerId);
			expect(after.filter((p) => p.cmdline.includes('sleep')).length).toBeLessThan(
				before.filter((p) => p.cmdline.includes('sleep')).length,
			);
		},
		TIMEOUT,
	);

	it(
		'preserves the filesystem across a suspend and resume',
		async () => {
			// What the chat's resume path and the pool's suspend rung both rest on. If
			// this ever fails, suspend has become destroy and both need rethinking.
			await runAs(['sh', '-c', 'mkdir -p /workspace/live && echo kept > /workspace/live/marker']);

			await engine.stopContainer(containerId);
			const stopped = await engine.inspectContainer(containerId);
			expect(stopped).not.toBeNull();
			expect(stopped?.State.Running).toBe(false);

			await engine.startContainer(containerId);
			const resumed = await engine.inspectContainer(containerId);
			expect(resumed?.State.Running).toBe(true);
			expect((await runAs(['cat', '/workspace/live/marker'])).stdout).toContain('kept');
		},
		TIMEOUT,
	);

	it(
		'stages and reads back run artefacts through SandboxFiles',
		async () => {
			// The half that makes a whole agent run possible rather than just a
			// container lifecycle. There is no bind mount here, so every artefact a
			// run stages - the prompt file, the runtime home and its credentials, the
			// tunnel config - reaches the sandbox only through this.
			const files = engine.files(containerId, '/workspace/runfiles');

			await files.write('prompt.txt', 'do the thing\n');
			expect(await files.read('prompt.txt')).toBe('do the thing\n');

			// Visible to processes inside the sandbox, not just to the API - which is
			// the only property the agent actually depends on.
			expect((await runAs(['cat', '/workspace/runfiles/prompt.txt'])).stdout).toContain(
				'do the thing',
			);

			// The mode contract: 0600 on a credential, 0711 on the directories above
			// it so the deprivileged run user can traverse without listing. A backend
			// that dropped either would lock the run out or widen a secret, and
			// neither fails loudly.
			await files.write('home/.config/creds.json', '{"token":"x"}', {
				mode: 0o600,
				dirMode: 0o711,
			});
			const modes = await runAs([
				'sh',
				'-c',
				'stat -c %a /workspace/runfiles/home/.config/creds.json; stat -c %a /workspace/runfiles/home/.config',
			]);
			const [fileMode, dirMode] = modes.stdout.trim().split('\n');
			expect(fileMode.trim()).toBe('600');
			expect(dirMode.trim()).toBe('711');

			// The read-back direction: what a runtime writes and the host scrapes.
			await runAs([
				'sh',
				'-c',
				'mkdir -p /workspace/runfiles/logs/a/b && echo used > /workspace/runfiles/logs/a/b/wire.jsonl',
			]);
			expect(await files.findByName('logs', 'wire.jsonl', 3)).toContain('logs/a/b/wire.jsonl');

			expect(await files.exists('prompt.txt')).toBe(true);
			await files.remove('prompt.txt');
			expect(await files.exists('prompt.txt')).toBe(false);
			// A missing file is not an error, by contract.
			await files.remove('prompt.txt');
		},
		TIMEOUT,
	);

	it('refuses a file path that escapes the run root', async () => {
		// The rule that keeps the interface switchable: a caller able to climb out
		// has silently opted into a host-shaped path.
		const files = engine.files(containerId, '/workspace/runfiles');
		await expect(files.read('../../etc/passwd')).rejects.toThrow(/escapes its root/);
	});

	it(
		'answers a duplicate session create with a usable 409, and a repeat delete with 404',
		async () => {
			// The measurement the transient-retry policy rests on, kept here because
			// it is a claim about the provider and nothing else can notice it moving.
			//
			// `executeStreaming` re-sends its session create on a gateway failure -
			// the only POST in the client that is retried - and that is safe solely
			// because the session id is minted on this side, so the re-send carries
			// the same id. Two things have to hold for that: the duplicate has to be
			// *recognised* rather than silently opening a second shell, and the
			// session has to still work afterwards, since the retry's whole point is
			// that the exec then proceeds on it. If either stops being true, the
			// retry must go, so this failing is a signal to change the client - not
			// a test to relax.
			//
			// The delete is the same argument for teardown: a re-sent delete that had
			// already landed must not read as a failed teardown.
			const client = new DaytonaClient(apiKey as string, process.env.HEZO_DAYTONA_API_URL);
			const record = await client.getSandbox(containerId);
			expect(record).not.toBeNull();
			const base = `${record?.toolboxProxyUrl}/${containerId}`;
			const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
			const sessionId = `hezo-live-${Math.random().toString(36).slice(2, 10)}`;
			const post = (path: string, body?: unknown) =>
				fetch(`${base}${path}`, {
					method: 'POST',
					headers: auth,
					body: body === undefined ? undefined : JSON.stringify(body),
				});

			expect((await post('/process/session', { sessionId })).status).toBe(201);

			const duplicate = await post('/process/session', { sessionId });
			expect(duplicate.status).toBe(409);
			expect(await duplicate.text()).toContain('already exists');

			// Usable after the conflict - the exec, its log stream and its command
			// record all still answer for this session.
			const started = await post(`/process/session/${sessionId}/exec`, {
				command: `sh -c 'echo still-usable; exit 7'`,
				runAsync: true,
			});
			const { cmdId } = (await started.json()) as { cmdId: string };
			const logs = await fetch(
				`${base}/process/session/${sessionId}/command/${cmdId}/logs?follow=true`,
				{ headers: { Authorization: `Bearer ${apiKey}` } },
			);
			expect(await logs.text()).toContain('still-usable');
			// Final by the time the follow stream closes, which is what lets
			// `executeStreaming` read it in one request rather than polling.
			const info = await fetch(`${base}/process/session/${sessionId}/command/${cmdId}`, {
				headers: { Authorization: `Bearer ${apiKey}` },
			});
			expect(((await info.json()) as { exitCode?: number }).exitCode).toBe(7);

			const del = (n: number) =>
				fetch(`${base}/process/session/${sessionId}`, {
					method: 'DELETE',
					headers: { Authorization: `Bearer ${apiKey}` },
				}).then((r) => [n, r.status] as const);
			expect(await del(1)).toEqual([1, 204]);
			expect(await del(2)).toEqual([2, 404]);
		},
		TIMEOUT,
	);

	it(
		'reaps a sandbox this instance owns but no longer references',
		async () => {
			// Orphans are a cost failure rather than an error - nothing surfaces them -
			// so the sweep is the only thing that notices.
			// Twice: a container is destroyed only on its second consecutive sighting,
			// so one mid-provision on the engine but not yet recorded is never swept.
			const live = new Set<string>();
			const first = await reapOrphanedContainers(engine, instanceId, live);
			expect(first.destroyed).toEqual([]);
			const result = await reapOrphanedContainers(engine, instanceId, live, first.suspected);
			expect(result.destroyed).toContain(containerId);
			const gone = await engine.inspectContainer(containerId);
			expect(gone === null || gone.State.Running === false).toBe(true);
		},
		TIMEOUT,
	);
});
