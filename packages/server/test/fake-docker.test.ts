import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeDockerClient } from '../src/services/fake-docker';
import type { ExecLogChunk } from '../src/services/sandbox/types';
import { createAgentRun } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// Exercises the in-process Docker fake (createFakeDockerClient) directly: the
// container lifecycle map, the synthetic exec script, and the heartbeat-run
// produced_output side-effect that distinguishes it from a bare docker stub.

describe('createFakeDockerClient — container lifecycle (no db)', () => {
	const docker = createFakeDockerClient();

	it('ping / imageExists / pullImage all resolve happily', async () => {
		expect(await docker.ping()).toBe(true);
		expect(await docker.imageExists('anything')).toBe(true);
		await expect(docker.pullImage('anything')).resolves.toBeUndefined();
	});

	it('createContainer returns a deterministic noop id derived from the name', async () => {
		const res = await docker.createContainer('my-container');
		expect(res.Id).toBe('noop-my-container');
		expect(res.Warnings).toEqual([]);
	});

	it('a freshly created container inspects as exited (not yet started)', async () => {
		await docker.createContainer('lifecycle');
		const info = await docker.inspectContainer('noop-lifecycle');
		expect(info.State.Running).toBe(false);
		expect(info.State.Status).toBe('exited');
		expect(info.State.Pid).toBe(0);
		expect(info.Config.Image).toBe('noop');
	});

	it('startContainer flips the tracked container to running', async () => {
		await docker.createContainer('lifecycle2');
		await docker.startContainer('noop-lifecycle2');
		const info = await docker.inspectContainer('noop-lifecycle2');
		expect(info.State.Running).toBe(true);
		expect(info.State.Status).toBe('running');
		expect(info.State.Pid).toBe(1);
	});

	it('starting an unknown container id creates a running entry on the fly', async () => {
		await docker.startContainer('never-created');
		const info = await docker.inspectContainer('never-created');
		expect(info.State.Running).toBe(true);
	});

	it('stopContainer flips a running container back to stopped', async () => {
		await docker.createContainer('lifecycle3');
		await docker.startContainer('noop-lifecycle3');
		await docker.stopContainer('noop-lifecycle3');
		const info = await docker.inspectContainer('noop-lifecycle3');
		expect(info.State.Running).toBe(false);
	});

	it('stopping an unknown container is a no-op', async () => {
		await expect(docker.stopContainer('ghost')).resolves.toBeUndefined();
	});

	it('removeContainer drops the entry so inspect defaults to running=true', async () => {
		await docker.createContainer('lifecycle4');
		await docker.removeContainer('noop-lifecycle4');
		// Unknown-after-removal: inspect falls back to running=true.
		const info = await docker.inspectContainer('noop-lifecycle4');
		expect(info.State.Running).toBe(true);
	});

	it('containerLogs returns an empty Response body', async () => {
		const res = await docker.containerLogs('any', { follow: false });
		expect(res).not.toBeNull();
		const buf = await (res as Response).arrayBuffer();
		expect(buf.byteLength).toBe(0);
	});
});

describe('createFakeDockerClient — exec without onChunk', () => {
	const docker = createFakeDockerClient();

	it('returns empty stdout/stderr and runs no synthetic script', async () => {
		const execId = await docker.execCreate('cid', { Cmd: ['echo'] });
		expect(execId).toContain('noop-exec-');
		const result = await docker.execStart(execId, {});
		expect(result).toEqual({ stdout: '', stderr: '' });
	});

	it('execInspect reports a clean exit', async () => {
		const info = await docker.execInspect('noop-exec-1');
		expect(info.ExitCode).toBe(0);
		expect(info.Running).toBe(false);
	});
});

describe('createFakeDockerClient — synthetic exec with onChunk', () => {
	let ctx: ServerTestContext;
	let agentId: string;
	let teamId: string;

	beforeAll(async () => {
		ctx = await createTestContext();
		const r = await ctx.db.query<{ id: string; team_id: string }>(
			"SELECT id, team_id FROM members WHERE member_type = 'agent'::member_type LIMIT 1",
		);
		agentId = r.rows[0].id;
		teamId = r.rows[0].team_id;
	});
	afterAll(() => destroyTestContext(ctx));

	it('streams the deterministic synthetic script through onChunk', async () => {
		const docker = createFakeDockerClient();
		const execId = await docker.execCreate('cid', { Cmd: ['agent'] });
		const chunks: ExecLogChunk[] = [];
		await docker.execStart(execId, {
			onChunk: (c) => {
				chunks.push(c);
			},
		});
		expect(chunks.length).toBe(4);
		expect(chunks.every((c) => c.stream === 'stdout')).toBe(true);
		const streamed = chunks.map((c) => c.text).join('');
		expect(streamed).toContain('[synthetic] starting agent run');
		expect(streamed).toContain('[synthetic] task complete');
	});

	// Locks the streaming contract the real client honours: a streamed exec
	// retains nothing, so anything a caller needs must come off the chunks. A
	// fake that returned the transcript would let a test pass against a
	// contract production does not offer.
	it('retains no transcript on the streaming path', async () => {
		const docker = createFakeDockerClient();
		const execId = await docker.execCreate('cid', { Cmd: ['agent'] });
		const result = await docker.execStart(execId, { onChunk: () => {} });
		expect(result).toEqual({ stdout: '', stderr: '' });
	});

	it('marks the heartbeat run as having produced output when run id env + db are present', async () => {
		const runId = await createAgentRun(ctx.db, agentId, teamId, null);
		const docker = createFakeDockerClient(ctx.db);
		const execId = await docker.execCreate('cid', {
			Env: [`HEZO_HEARTBEAT_RUN_ID=${runId}`, 'OTHER=1'],
		});
		await docker.execStart(execId, { onChunk: () => {} });

		const row = await ctx.db.query<{ produced_output: boolean }>(
			'SELECT produced_output FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(row.rows[0].produced_output).toBe(true);
	});

	it('does not touch the db when no run id env was supplied at exec-create', async () => {
		const runId = await createAgentRun(ctx.db, agentId, teamId, null);
		const docker = createFakeDockerClient(ctx.db);
		// No HEZO_HEARTBEAT_RUN_ID in env → execRunIds maps to null → no update.
		const execId = await docker.execCreate('cid', { Env: ['UNRELATED=1'] });
		await docker.execStart(execId, { onChunk: () => {} });

		const row = await ctx.db.query<{ produced_output: boolean }>(
			'SELECT produced_output FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(row.rows[0].produced_output).toBe(false);
	});

	it('aborts the synthetic script when the signal is already aborted', async () => {
		const docker = createFakeDockerClient();
		const execId = await docker.execCreate('cid');
		const controller = new AbortController();
		controller.abort();
		await expect(
			docker.execStart(execId, { signal: controller.signal, onChunk: () => {} }),
		).rejects.toThrow(/Aborted/);
	});
});
