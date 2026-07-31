import { existsSync } from 'node:fs';
import { HeartbeatRunStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import type { ContainerLogStreamer } from '../src/services/container-logs';
import {
	type ContainerDeps,
	captureContainerLogs,
	consumeFinalMemoryLine,
	ensureProjectContainerRunning,
	failProjectRuns,
	type ProjectRow,
	rebuildContainer,
	setKeepOldContainers,
	shouldKeepOldContainers,
	stopContainerGracefully,
	syncAllContainerStatuses,
	syncContainerStatus,
	teardownContainer,
} from '../src/services/containers';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { ensureProjectWorkspace, getProjectDir } from '../src/services/workspace';
import type { WebSocketManager } from '../src/services/ws';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: Db;
let dataDir: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let planningTaskId: string;
let agentId: string;

/** Encode one Docker multiplexed log frame into an exact-size ArrayBuffer. */
function logsBody(text: string, streamType: 1 | 2 = 1): ArrayBuffer {
	const payload = new TextEncoder().encode(text);
	const frame = new Uint8Array(8 + payload.length);
	frame[0] = streamType;
	frame[4] = (payload.length >> 24) & 0xff;
	frame[5] = (payload.length >> 16) & 0xff;
	frame[6] = (payload.length >> 8) & 0xff;
	frame[7] = payload.length & 0xff;
	frame.set(payload, 8);
	return frame.buffer;
}

/** A stub docker able to complete a full provision (fresh Id per call). */
function provisioningDocker(overrides: Record<string, unknown> = {}) {
	let seq = 0;
	return createStubDocker({
		createContainer: vi.fn(async () => ({
			Id: `lifecycle-cid-${Date.now().toString(16)}-${seq++}`,
			Warnings: [],
		})),
		startContainer: vi.fn(async () => {}),
		execCreate: vi.fn(async () => 'exec-x'),
		execStart: vi.fn(async () => ({ stdout: '', stderr: '' })),
		execInspect: vi.fn(async () => ({ ExitCode: 1, Running: false, Pid: 0 })),
		...overrides,
	});
}

function fakeWs() {
	return { broadcast: vi.fn() } as unknown as WebSocketManager & {
		broadcast: ReturnType<typeof vi.fn>;
	};
}

function deps(docker: ContainerEngine, extra: Partial<ContainerDeps> = {}): ContainerDeps {
	return { db, docker, dataDir, ...extra };
}

async function resetContainerRow(): Promise<void> {
	await db.query(
		`UPDATE projects SET container_id = NULL, container_status = NULL,
		 container_error = NULL, container_last_logs = NULL WHERE id = $1`,
		[projectId],
	);
	consumeFinalMemoryLine(projectId);
}

async function projectRow(): Promise<ProjectRow> {
	const r = await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId]);
	return r.rows[0];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Lifecycle Coverage Co' });
	const team = (await teamRes.json()).data;
	teamId = team.id;

	const projRes = await createTestProject(db, teamId, {
		name: 'Lifecycle Coverage Project',
		description: 'Container lifecycle branch coverage.',
	});
	const project = (await projRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;
	planningTaskId = project.planning_task_id as string;

	const agent = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.admin_status = 'enabled' LIMIT 1`,
		[teamId],
	);
	agentId = agent.rows[0].id;
});

afterAll(async () => {
	setKeepOldContainers(false);
	await safeClose(db);
});

describe('keep-old-containers flag', () => {
	it('setKeepOldContainers toggles shouldKeepOldContainers', () => {
		expect(shouldKeepOldContainers()).toBe(false);
		setKeepOldContainers(true);
		expect(shouldKeepOldContainers()).toBe(true);
		setKeepOldContainers(false);
		expect(shouldKeepOldContainers()).toBe(false);
	});
});

describe('captureContainerLogs', () => {
	it('caps the captured tail at 32 KiB', async () => {
		const marker = 'THE-VERY-LAST-LINE';
		const body = 'x'.repeat(40_000) + marker;
		const docker = createStubDocker({
			containerLogs: vi.fn(async () => ({ arrayBuffer: async () => logsBody(body) })),
		});
		const out = await captureContainerLogs(docker, 'cap-cid', projectSlug);
		expect(out).not.toBeNull();
		expect(out?.length).toBe(32 * 1024);
		expect(out?.endsWith(marker)).toBe(true);
		// The head was sliced off, only the tail is kept.
		expect(out?.startsWith('x'.repeat(100))).toBe(true);
	});

	it('ignores a truncated trailing frame', async () => {
		const full = new Uint8Array(logsBody('complete line\n'));
		// A second frame header that claims 100 bytes but delivers only 4.
		const partial = new Uint8Array(12);
		partial[0] = 1;
		partial[7] = 100;
		partial.set(new TextEncoder().encode('oops'), 8);
		const combined = new Uint8Array(full.length + partial.length);
		combined.set(full);
		combined.set(partial, full.length);
		const docker = createStubDocker({
			containerLogs: vi.fn(async () => ({ arrayBuffer: async () => combined.buffer })),
		});
		const out = await captureContainerLogs(docker, 'trunc-cid');
		expect(out).toBe('complete line\n');
	});

	it('returns null for an empty log buffer', async () => {
		const docker = createStubDocker({
			containerLogs: vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
		});
		expect(await captureContainerLogs(docker, 'empty-cid')).toBeNull();
	});

	it('returns null when the container is gone (logs endpoint 404s)', async () => {
		const docker = createStubDocker({ containerLogs: vi.fn(async () => null) });
		expect(await captureContainerLogs(docker, 'gone-cid')).toBeNull();
	});

	it('returns null (never throws) when the docker transport fails', async () => {
		const docker = createStubDocker({
			containerLogs: vi.fn(async () => {
				throw new Error('EPIPE');
			}),
		});
		await expect(captureContainerLogs(docker, 'broken-cid', projectSlug)).resolves.toBeNull();
	});
});

describe('ensureProjectContainerRunning', () => {
	it('throws when the project does not exist', async () => {
		await expect(
			ensureProjectContainerRunning(
				deps(createStubDocker()),
				'00000000-0000-0000-0000-000000000000',
			),
		).rejects.toThrow('Project not found');
	});

	it('returns the stored container id untouched when Docker confirms it is running', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'already-running', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const docker = createStubDocker({
			inspectContainer: vi.fn(async () => ({
				Id: 'already-running',
				State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
				Config: { Image: 'stub' },
			})),
			createContainer: vi.fn(),
			startContainer: vi.fn(),
		});

		const id = await ensureProjectContainerRunning(deps(docker), projectId);

		expect(id).toBe('already-running');
		expect(docker.createContainer).not.toHaveBeenCalled();
		expect(docker.startContainer).not.toHaveBeenCalled();
	});

	it('starts a stopped container in place, resubscribes logs, and broadcasts', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'stopped-in-place', container_status = 'stopped'::container_status, container_error = 'old error' WHERE id = $1",
			[projectId],
		);
		const startContainer = vi.fn(async () => {});
		const docker = createStubDocker({
			inspectContainer: vi.fn(async () => ({
				Id: 'stopped-in-place',
				State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
				Config: { Image: 'stub' },
			})),
			startContainer,
			createContainer: vi.fn(),
		});
		const wsManager = fakeWs();
		const subscribe = vi.fn();
		const { LogStreamBroker } = await import('../src/services/log-stream-broker');
		const logs = new LogStreamBroker();

		const id = await ensureProjectContainerRunning(
			deps(docker, {
				wsManager,
				logs,
				containerLogStreamer: { subscribe } as unknown as ContainerLogStreamer,
			}),
			projectId,
		);

		expect(id).toBe('stopped-in-place');
		expect(startContainer).toHaveBeenCalledWith('stopped-in-place');
		expect(docker.createContainer).not.toHaveBeenCalled();
		expect(subscribe).toHaveBeenCalledWith(projectId, 'stopped-in-place', logs, docker);
		expect(wsManager.broadcast).toHaveBeenCalled();

		const row = await db.query<{ container_status: string; container_error: string | null }>(
			'SELECT container_status, container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('running');
		expect(row.rows[0].container_error).toBeNull();
	});

	it('reprovisions when the stored container id no longer exists in Docker', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'vanished-cid', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const docker = provisioningDocker({ inspectContainer: vi.fn(async () => null) });

		const id = await ensureProjectContainerRunning(deps(docker), projectId);

		expect(id).not.toBe('vanished-cid');
		expect(docker.createContainer).toHaveBeenCalledTimes(1);
		const row = await db.query<{ container_id: string; container_status: string }>(
			'SELECT container_id, container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_id).toBe(id);
		expect(row.rows[0].container_status).toBe('running');
	});

	it('provisions from scratch when no container was ever created', async () => {
		await resetContainerRow();
		const docker = provisioningDocker({
			inspectContainer: vi.fn(async () => null),
		});

		const id = await ensureProjectContainerRunning(deps(docker), projectId);

		expect(docker.createContainer).toHaveBeenCalledTimes(1);
		// The stored id is never inspected when it is NULL.
		expect(docker.inspectContainer).not.toHaveBeenCalled();
		const row = await db.query<{ container_id: string }>(
			'SELECT container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_id).toBe(id);
	});
});

describe('teardownContainer', () => {
	it('stops and removes the container, clears the row, and removes the workspace', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'teardown-cid', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const projectDir = ensureProjectWorkspace(dataDir, teamId, projectId);
		expect(existsSync(projectDir)).toBe(true);

		const stopContainer = vi.fn(async () => {});
		const removeContainer = vi.fn(async () => {});
		const docker = createStubDocker({ stopContainer, removeContainer });

		await teardownContainer(deps(docker), projectId, projectSlug, teamId);

		expect(stopContainer).toHaveBeenCalledWith('teardown-cid');
		expect(removeContainer).toHaveBeenCalledWith('teardown-cid', true);
		expect(existsSync(getProjectDir(dataDir, teamId, projectId))).toBe(false);
		const row = await db.query<{ container_id: string | null; container_status: string | null }>(
			'SELECT container_id, container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_id).toBeNull();
		expect(row.rows[0].container_status).toBeNull();
	});

	it('tolerates stop/remove failures for an already-gone container', async () => {
		await resetContainerRow();
		await db.query("UPDATE projects SET container_id = 'flaky-cid' WHERE id = $1", [projectId]);
		const docker = createStubDocker({
			stopContainer: vi.fn(async () => {
				throw new Error('already stopped');
			}),
			removeContainer: vi.fn(async () => {
				throw new Error('already removed');
			}),
		});

		await teardownContainer(deps(docker), projectId, projectSlug, teamId);

		const row = await db.query<{ container_id: string | null }>(
			'SELECT container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_id).toBeNull();
	});

	it('retains the old container when keep-old-containers is enabled', async () => {
		await resetContainerRow();
		await db.query("UPDATE projects SET container_id = 'kept-cid' WHERE id = $1", [projectId]);
		const stopContainer = vi.fn();
		const removeContainer = vi.fn();
		const docker = createStubDocker({ stopContainer, removeContainer });

		setKeepOldContainers(true);
		try {
			await teardownContainer(deps(docker), projectId, projectSlug, teamId);
		} finally {
			setKeepOldContainers(false);
		}

		expect(stopContainer).not.toHaveBeenCalled();
		expect(removeContainer).not.toHaveBeenCalled();
		// The DB row is still cleared even though the container stays around.
		const row = await db.query<{ container_id: string | null }>(
			'SELECT container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_id).toBeNull();
	});

	it('handles a project that never had a container', async () => {
		await resetContainerRow();
		const stopContainer = vi.fn();
		const removeContainer = vi.fn();
		const docker = createStubDocker({ stopContainer, removeContainer });

		await teardownContainer(deps(docker), projectId, projectSlug, teamId);

		expect(stopContainer).not.toHaveBeenCalled();
		expect(removeContainer).not.toHaveBeenCalled();
	});
});

describe('stopContainerGracefully', () => {
	async function insertRunningRun(): Promise<string> {
		const res = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status) RETURNING id`,
			[teamId, agentId, planningTaskId, HeartbeatRunStatus.Running],
		);
		return res.rows[0].id;
	}

	it('captures last logs, stops, and fails in-flight runs with container_stopped', async () => {
		await resetContainerRow();
		await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
		await db.query(
			"UPDATE projects SET container_id = 'graceful-cid', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const runId = await insertRunningRun();
		const docker = createStubDocker({
			stopContainer: vi.fn(async () => {}),
			containerLogs: vi.fn(async () => ({
				arrayBuffer: async () => logsBody('final console output\n'),
			})),
		});

		await stopContainerGracefully(deps(docker), projectId, projectSlug, teamId, 'graceful-cid');

		const row = await db.query<{ container_status: string; container_last_logs: string | null }>(
			'SELECT container_status, container_last_logs FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('stopped');
		expect(row.rows[0].container_last_logs).toContain('final console output');

		const run = await db.query<{ status: string; error: string | null; exit_code: number }>(
			'SELECT status, error, exit_code FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toBe('container_stopped');
		expect(run.rows[0].exit_code).toBe(-1);
	});

	it('records an error status and fails runs with container_error when the stop fails', async () => {
		await resetContainerRow();
		await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
		await db.query(
			"UPDATE projects SET container_id = 'stubborn-cid', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const runId = await insertRunningRun();
		const docker = createStubDocker({
			stopContainer: vi.fn(async () => {
				throw new Error('daemon wedged');
			}),
			containerLogs: vi.fn(async () => null),
		});

		await stopContainerGracefully(deps(docker), projectId, projectSlug, teamId, 'stubborn-cid');

		const row = await db.query<{ container_status: string; container_error: string | null }>(
			'SELECT container_status, container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('error');
		expect(row.rows[0].container_error).toBe('daemon wedged');

		const run = await db.query<{ error: string | null }>(
			'SELECT error FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].error).toBe('container_error');
	});
});

describe('rebuildContainer', () => {
	it('snapshots the old container logs, removes it, and provisions a replacement', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'old-rebuild-cid', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const stopContainer = vi.fn(async () => {});
		const removeContainer = vi.fn(async () => {});
		const docker = provisioningDocker({
			stopContainer,
			removeContainer,
			containerLogs: vi.fn(async () => ({
				arrayBuffer: async () => logsBody('pre-rebuild console output\n'),
			})),
		});

		const newId = await rebuildContainer(deps(docker), await projectRow(), 'lifecycle-coverage-co');

		expect(newId).not.toBe('old-rebuild-cid');
		expect(stopContainer).toHaveBeenCalledWith('old-rebuild-cid');
		expect(removeContainer).toHaveBeenCalledWith('old-rebuild-cid', true);
		const row = await db.query<{
			container_id: string;
			container_status: string;
			container_last_logs: string | null;
		}>('SELECT container_id, container_status, container_last_logs FROM projects WHERE id = $1', [
			projectId,
		]);
		expect(row.rows[0].container_id).toBe(newId);
		expect(row.rows[0].container_status).toBe('running');
		expect(row.rows[0].container_last_logs).toContain('pre-rebuild console output');
	});

	it('keeps the old container when keep-old-containers is enabled', async () => {
		await resetContainerRow();
		await db.query("UPDATE projects SET container_id = 'kept-rebuild-cid' WHERE id = $1", [
			projectId,
		]);
		const stopContainer = vi.fn();
		const removeContainer = vi.fn();
		const docker = provisioningDocker({
			stopContainer,
			removeContainer,
			containerLogs: vi.fn(async () => null),
		});

		setKeepOldContainers(true);
		let newId: string;
		try {
			newId = await rebuildContainer(deps(docker), await projectRow(), 'lifecycle-coverage-co');
		} finally {
			setKeepOldContainers(false);
		}

		expect(stopContainer).not.toHaveBeenCalled();
		expect(removeContainer).not.toHaveBeenCalled();
		expect(newId).toBeTruthy();
		expect(docker.createContainer).toHaveBeenCalledTimes(1);
	});

	it('tolerates stop/remove failures on the old container and still provisions', async () => {
		await resetContainerRow();
		await db.query("UPDATE projects SET container_id = 'half-gone-cid' WHERE id = $1", [projectId]);
		const docker = provisioningDocker({
			stopContainer: vi.fn(async () => {
				throw new Error('already stopped');
			}),
			removeContainer: vi.fn(async () => {
				throw new Error('already removed');
			}),
			containerLogs: vi.fn(async () => null),
		});

		const newId = await rebuildContainer(deps(docker), await projectRow(), 'lifecycle-coverage-co');

		expect(newId).toBeTruthy();
		expect(docker.createContainer).toHaveBeenCalledTimes(1);
		const row = await db.query<{ container_id: string; container_status: string }>(
			'SELECT container_id, container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_id).toBe(newId);
		expect(row.rows[0].container_status).toBe('running');
	});

	it('provisions directly when there is no previous container', async () => {
		await resetContainerRow();
		const stopContainer = vi.fn();
		const docker = provisioningDocker({ stopContainer });

		const newId = await rebuildContainer(deps(docker), await projectRow(), 'lifecycle-coverage-co');

		expect(stopContainer).not.toHaveBeenCalled();
		expect(docker.createContainer).toHaveBeenCalledTimes(1);
		expect(newId).toBeTruthy();
	});
});

describe('syncContainerStatus', () => {
	it('returns null and leaves the row untouched on a transport error', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'transient-cid', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const docker = createStubDocker({
			inspectContainer: vi.fn(async () => {
				throw new Error('socket hang up');
			}),
		});

		const status = await syncContainerStatus(
			db,
			docker,
			projectId,
			projectSlug,
			'transient-cid',
			'running',
		);

		expect(status).toBeNull();
		const row = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('running');
	});

	it('marks the project errored and clears the id when the container was removed externally', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'externally-removed', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const docker = createStubDocker({ inspectContainer: vi.fn(async () => null) });

		const status = await syncContainerStatus(
			db,
			docker,
			projectId,
			projectSlug,
			'externally-removed',
			'running',
		);

		expect(status).toBe('error');
		const row = await db.query<{ container_id: string | null; container_error: string | null }>(
			'SELECT container_id, container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_id).toBeNull();
		expect(row.rows[0].container_error).toContain('no longer exists');
	});

	it('records a clean-exit message (no exit code) for a running→stopped transition with code 0', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'clean-exit', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const docker = createStubDocker({
			inspectContainer: vi.fn(async () => ({
				Id: 'clean-exit',
				State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
				Config: { Image: 'stub' },
			})),
			containerLogs: vi.fn(async () => null),
		});

		const status = await syncContainerStatus(
			db,
			docker,
			projectId,
			projectSlug,
			'clean-exit',
			'running',
		);

		expect(status).toBe('stopped');
		const row = await db.query<{ container_error: string | null }>(
			'SELECT container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_error).toBe('Container stopped (exited).');
	});

	it('updates the status without log capture when there is no running→stopped transition', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'steady-cid', container_status = 'creating'::container_status WHERE id = $1",
			[projectId],
		);
		const containerLogs = vi.fn();
		const docker = createStubDocker({
			inspectContainer: vi.fn(async () => ({
				Id: 'steady-cid',
				State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
				Config: { Image: 'stub' },
			})),
			containerLogs,
		});

		const status = await syncContainerStatus(
			db,
			docker,
			projectId,
			projectSlug,
			'steady-cid',
			'creating',
		);

		expect(status).toBe('running');
		expect(containerLogs).not.toHaveBeenCalled();
		const row = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('running');
	});
});

describe('memory-limit enforcement edge cases', () => {
	it('records the memory-limit error even when the enforcement stop itself fails', async () => {
		await db.query('UPDATE projects SET container_id = NULL WHERE container_id IS NOT NULL');
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'mem-stop-fail', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const usedBytes = 20 * 1024 ** 3;
		const stopContainer = vi.fn(async () => {
			throw new Error('stop timed out');
		});
		const docker = createStubDocker({
			inspectContainer: vi.fn(async () => ({
				Id: 'mem-stop-fail',
				State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
				Config: { Image: 'stub' },
			})),
			containerStats: vi.fn(async () => ({ usedBytes, rawUsageBytes: usedBytes })),
			stopContainer,
			containerLogs: vi.fn(async () => null),
		});

		const transitions = await syncAllContainerStatuses(deps(docker));

		expect(stopContainer).toHaveBeenCalledWith('mem-stop-fail');
		const row = await db.query<{ container_status: string; container_error: string | null }>(
			'SELECT container_status, container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('error');
		expect(row.rows[0].container_error).toContain('20.00 GiB');
		// No per-project override → the instance-wide default cap (2 GB) applies.
		expect(row.rows[0].container_error).toContain('2 GiB');
		expect(transitions).toEqual([
			expect.objectContaining({ projectId, oldStatus: 'running', newStatus: 'error' }),
		]);
		// The memory readout was consumed by the auto-stop.
		expect(consumeFinalMemoryLine(projectId)).toBeNull();
	});

	it('leaves a running container alone when stats are unavailable', async () => {
		await resetContainerRow();
		await db.query(
			"UPDATE projects SET container_id = 'no-stats-cid', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		const stopContainer = vi.fn();
		const docker = createStubDocker({
			inspectContainer: vi.fn(async () => ({
				Id: 'no-stats-cid',
				State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
				Config: { Image: 'stub' },
			})),
			containerStats: vi.fn(async () => null),
			stopContainer,
		});

		const transitions = await syncAllContainerStatuses(deps(docker));

		expect(stopContainer).not.toHaveBeenCalled();
		expect(transitions).toEqual([]);
		const row = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('running');
	});
});

describe('failProjectRuns', () => {
	it('returns early without broadcasting when no runs are in flight', async () => {
		await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
		const wsManager = fakeWs();

		await failProjectRuns(
			deps(createStubDocker(), { wsManager }),
			projectId,
			projectSlug,
			teamId,
			'container_error',
		);

		expect(wsManager.broadcast).not.toHaveBeenCalled();
	});
});
