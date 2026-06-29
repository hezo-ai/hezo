import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	type ContainerDeps,
	captureContainerLogs,
	ensureProjectContainerRunning,
	type ProjectRow,
	rebuildContainer,
	setKeepOldContainers,
	shouldKeepOldContainers,
	syncContainerStatus,
	teardownContainer,
	verifyContainerWorkspace,
} from '../src/services/containers';
import type { DockerClient } from '../src/services/docker';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;

function deps(docker: DockerClient, extra: Partial<ContainerDeps> = {}): ContainerDeps {
	return { db, docker, dataDir: mkdtempSync(join(tmpdir(), 'hezo-cc-')), ...extra };
}

async function makeProject(name: string): Promise<{ id: string }> {
	const res = await createTestProject(db, teamId, { name, description: 'cc test' });
	const id = (await res.json()).data.id;
	// Let any auto-provision settle, then reset to a clean state.
	await new Promise((r) => setTimeout(r, 100));
	await db.query(
		"UPDATE projects SET container_id = NULL, container_status = NULL, docker_base_image = 'test-unregistered:latest' WHERE id = $1",
		[id],
	);
	return { id };
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Containers Cov Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
});

afterAll(async () => {
	setKeepOldContainers(false);
	await safeClose(db);
});

describe('keep-old-containers flag', () => {
	it('round-trips the global flag', () => {
		expect(shouldKeepOldContainers()).toBe(false);
		setKeepOldContainers(true);
		expect(shouldKeepOldContainers()).toBe(true);
		setKeepOldContainers(false);
		expect(shouldKeepOldContainers()).toBe(false);
	});
});

describe('captureContainerLogs', () => {
	it('returns null when docker.containerLogs throws (warn path)', async () => {
		const docker = createStubDocker({
			containerLogs: vi.fn().mockRejectedValue(new Error('logs gone')),
		});
		const out = await captureContainerLogs(docker, 'cid-1234567890', 'slug');
		expect(out).toBeNull();
	});

	it('returns null when docker.containerLogs returns null', async () => {
		const docker = createStubDocker({
			containerLogs: vi.fn().mockResolvedValue(null),
		});
		expect(await captureContainerLogs(docker, 'cid', 'slug')).toBeNull();
	});

	it('truncates output to the last-logs cap', async () => {
		// Build one giant Docker multiplexed frame > 32 KiB.
		const body = 'x'.repeat(40 * 1024);
		const payload = new TextEncoder().encode(body);
		const frame = new Uint8Array(8 + payload.length);
		frame[0] = 1;
		frame[4] = (payload.length >> 24) & 0xff;
		frame[5] = (payload.length >> 16) & 0xff;
		frame[6] = (payload.length >> 8) & 0xff;
		frame[7] = payload.length & 0xff;
		frame.set(payload, 8);
		const docker = createStubDocker({
			containerLogs: vi.fn().mockResolvedValue({ arrayBuffer: async () => frame.buffer }),
		});
		const out = await captureContainerLogs(docker, 'cid', 'slug');
		expect(out).not.toBeNull();
		expect((out as string).length).toBe(32 * 1024);
	});
});

describe('ensureProjectContainerRunning', () => {
	it('throws when the project does not exist', async () => {
		await expect(
			ensureProjectContainerRunning(deps(createStubDocker()), crypto.randomUUID()),
		).rejects.toThrow('Project not found');
	});

	it('returns the existing id when Docker reports the container running', async () => {
		const { id } = await makeProject('Already Running Proj');
		await db.query(
			"UPDATE projects SET container_id = 'live-cid', container_status = 'running'::container_status WHERE id = $1",
			[id],
		);
		const startContainer = vi.fn();
		const docker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({ State: { Running: true } }),
			startContainer,
		});

		const result = await ensureProjectContainerRunning(deps(docker), id);
		expect(result).toBe('live-cid');
		expect(startContainer).not.toHaveBeenCalled();
	});

	it('starts a stopped-but-existing container in place and marks it running', async () => {
		const { id } = await makeProject('Restart In Place Proj');
		await db.query(
			"UPDATE projects SET container_id = 'stopped-cid', container_status = 'stopped'::container_status, container_error = 'old error' WHERE id = $1",
			[id],
		);
		const startContainer = vi.fn().mockResolvedValue(undefined);
		const broadcast = vi.fn();
		const docker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({ State: { Running: false } }),
			startContainer,
		});

		const result = await ensureProjectContainerRunning(
			deps(docker, { wsManager: { broadcast } as never }),
			id,
		);
		expect(result).toBe('stopped-cid');
		expect(startContainer).toHaveBeenCalledWith('stopped-cid');
		const row = await db.query<{ container_status: string; container_error: string | null }>(
			'SELECT container_status, container_error FROM projects WHERE id = $1',
			[id],
		);
		expect(row.rows[0].container_status).toBe('running');
		expect(row.rows[0].container_error).toBeNull();
		expect(broadcast).toHaveBeenCalled();
	});

	it('provisions from scratch when the stored container id no longer exists in Docker', async () => {
		const { id } = await makeProject('Reprovision Proj');
		await db.query(
			"UPDATE projects SET container_id = 'ghost-cid', container_status = 'running'::container_status WHERE id = $1",
			[id],
		);
		const docker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue(null),
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'fresh-cid' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		});

		const result = await ensureProjectContainerRunning(deps(docker), id);
		expect(result).toBe('fresh-cid');
	});

	it('provisions when there is no stored container id', async () => {
		const { id } = await makeProject('Never Provisioned Proj');
		const docker = createStubDocker({
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'first-cid' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		});
		const result = await ensureProjectContainerRunning(deps(docker), id);
		expect(result).toBe('first-cid');
	});
});

describe('teardownContainer', () => {
	it('stops and removes the container then clears project columns', async () => {
		setKeepOldContainers(false);
		const { id } = await makeProject('Teardown Proj');
		await db.query(
			"UPDATE projects SET container_id = 'teardown-cid', container_status = 'running'::container_status WHERE id = $1",
			[id],
		);
		const stopContainer = vi.fn().mockResolvedValue(undefined);
		const removeContainer = vi.fn().mockResolvedValue(undefined);
		const docker = createStubDocker({ stopContainer, removeContainer });

		await teardownContainer(deps(docker), id, 'teardown-proj', teamId);

		expect(stopContainer).toHaveBeenCalledWith('teardown-cid');
		expect(removeContainer).toHaveBeenCalledWith('teardown-cid', true);
		const row = await db.query<{ container_id: string | null; container_status: string | null }>(
			'SELECT container_id, container_status FROM projects WHERE id = $1',
			[id],
		);
		expect(row.rows[0].container_id).toBeNull();
		expect(row.rows[0].container_status).toBeNull();
	});

	it('swallows stop/remove errors (already-gone container)', async () => {
		const { id } = await makeProject('Teardown Errors Proj');
		await db.query(
			"UPDATE projects SET container_id = 'gone-cid', container_status = 'running'::container_status WHERE id = $1",
			[id],
		);
		const docker = createStubDocker({
			stopContainer: vi.fn().mockRejectedValue(new Error('already stopped')),
			removeContainer: vi.fn().mockRejectedValue(new Error('already removed')),
		});

		await expect(
			teardownContainer(deps(docker), id, 'teardown-errors-proj', teamId),
		).resolves.toBeUndefined();
		const row = await db.query<{ container_id: string | null }>(
			'SELECT container_id FROM projects WHERE id = $1',
			[id],
		);
		expect(row.rows[0].container_id).toBeNull();
	});

	it('does not touch docker when keep-old-containers is set', async () => {
		setKeepOldContainers(true);
		const { id } = await makeProject('Teardown Keep Proj');
		await db.query(
			"UPDATE projects SET container_id = 'kept-cid', container_status = 'running'::container_status WHERE id = $1",
			[id],
		);
		const stopContainer = vi.fn();
		const removeContainer = vi.fn();
		const docker = createStubDocker({ stopContainer, removeContainer });

		await teardownContainer(deps(docker), id, 'teardown-keep-proj', teamId);

		expect(stopContainer).not.toHaveBeenCalled();
		expect(removeContainer).not.toHaveBeenCalled();
		const row = await db.query<{ container_id: string | null }>(
			'SELECT container_id FROM projects WHERE id = $1',
			[id],
		);
		expect(row.rows[0].container_id).toBeNull();
		setKeepOldContainers(false);
	});

	it('handles a project with no provisioned container', async () => {
		const { id } = await makeProject('Teardown NoContainer Proj');
		const stopContainer = vi.fn();
		const docker = createStubDocker({ stopContainer });

		await teardownContainer(deps(docker), id, 'teardown-nc-proj', teamId);
		expect(stopContainer).not.toHaveBeenCalled();
	});
});

describe('verifyContainerWorkspace', () => {
	it('returns true when the workspace probe exits 0', async () => {
		const docker = createStubDocker({
			execCreate: vi.fn().mockResolvedValue('exec-1'),
			execStart: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
			execInspect: vi.fn().mockResolvedValue({ ExitCode: 0, Running: false, Pid: 0 }),
		});
		expect(await verifyContainerWorkspace(docker, 'cid')).toBe(true);
	});

	it('returns false when the workspace probe exits non-zero', async () => {
		const docker = createStubDocker({
			execCreate: vi.fn().mockResolvedValue('exec-1'),
			execStart: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
			execInspect: vi.fn().mockResolvedValue({ ExitCode: 1, Running: false, Pid: 0 }),
		});
		expect(await verifyContainerWorkspace(docker, 'cid')).toBe(false);
	});

	it('returns false when the exec throws (stale mount)', async () => {
		const docker = createStubDocker({
			execCreate: vi.fn().mockRejectedValue(new Error('outside of container mount namespace')),
		});
		expect(await verifyContainerWorkspace(docker, 'cid')).toBe(false);
	});
});

describe('rebuildContainer', () => {
	it('rebuilds with no previous container (logs the no-previous path)', async () => {
		const { id } = await makeProject('Rebuild Fresh Proj');
		const docker = createStubDocker({
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'rebuilt-fresh-cid' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		});
		const project = (await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]))
			.rows[0];

		const result = await rebuildContainer(deps(docker), project, 'containers-cov-co');
		expect(result).toBe('rebuilt-fresh-cid');
	});

	it('removes the previous container, captures its logs, then provisions a fresh one', async () => {
		setKeepOldContainers(false);
		const { id } = await makeProject('Rebuild Existing Proj');
		await db.query("UPDATE projects SET container_id = 'old-cid' WHERE id = $1", [id]);

		const body = 'previous logs line\n';
		const payload = new TextEncoder().encode(body);
		const frame = new Uint8Array(8 + payload.length);
		frame[0] = 1;
		frame[7] = payload.length & 0xff;
		frame.set(payload, 8);

		const stopContainer = vi.fn().mockResolvedValue(undefined);
		const removeContainer = vi.fn().mockResolvedValue(undefined);
		const docker = createStubDocker({
			containerLogs: vi.fn().mockResolvedValue({ arrayBuffer: async () => frame.buffer }),
			stopContainer,
			removeContainer,
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'rebuilt-cid' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		});
		const project = (await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]))
			.rows[0];

		const result = await rebuildContainer(deps(docker), project, 'containers-cov-co');
		expect(result).toBe('rebuilt-cid');
		expect(stopContainer).toHaveBeenCalledWith('old-cid');
		expect(removeContainer).toHaveBeenCalledWith('old-cid', true);
		const row = await db.query<{ container_last_logs: string | null }>(
			'SELECT container_last_logs FROM projects WHERE id = $1',
			[id],
		);
		expect(row.rows[0].container_last_logs).toContain('previous logs line');
	});

	it('keeps the old container when keep-old-containers is set', async () => {
		setKeepOldContainers(true);
		const { id } = await makeProject('Rebuild Keep Proj');
		await db.query("UPDATE projects SET container_id = 'keep-old-cid' WHERE id = $1", [id]);

		const stopContainer = vi.fn();
		const removeContainer = vi.fn();
		const docker = createStubDocker({
			containerLogs: vi.fn().mockResolvedValue(null),
			stopContainer,
			removeContainer,
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'rebuilt-keep-cid' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		});
		const project = (await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]))
			.rows[0];

		await rebuildContainer(deps(docker), project, 'containers-cov-co');
		expect(stopContainer).not.toHaveBeenCalled();
		expect(removeContainer).not.toHaveBeenCalled();
		setKeepOldContainers(false);
	});

	it('swallows stop/remove errors during rebuild of a dead previous container', async () => {
		setKeepOldContainers(false);
		const { id } = await makeProject('Rebuild Dead Prev Proj');
		await db.query("UPDATE projects SET container_id = 'dead-prev-cid' WHERE id = $1", [id]);
		const docker = createStubDocker({
			containerLogs: vi.fn().mockResolvedValue(null),
			stopContainer: vi.fn().mockRejectedValue(new Error('gone')),
			removeContainer: vi.fn().mockRejectedValue(new Error('gone')),
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'rebuilt-after-dead' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		});
		const project = (await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]))
			.rows[0];

		await expect(rebuildContainer(deps(docker), project, 'containers-cov-co')).resolves.toBe(
			'rebuilt-after-dead',
		);
	});
});

describe('syncContainerStatus (direct)', () => {
	it('returns null on a transport error and leaves status untouched', async () => {
		const { id } = await makeProject('Direct Transport Err Proj');
		await db.query(
			"UPDATE projects SET container_id = 'cid', container_status = 'running'::container_status WHERE id = $1",
			[id],
		);
		const docker = createStubDocker({
			inspectContainer: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
		});
		const status = await syncContainerStatus(db, docker, id, 'slug', 'cid', 'running');
		expect(status).toBeNull();
	});

	it('records a clean stop (exit code 0) message on running→stopped', async () => {
		const { id } = await makeProject('Direct Clean Stop Proj');
		await db.query(
			"UPDATE projects SET container_id = 'cid', container_status = 'running'::container_status WHERE id = $1",
			[id],
		);
		const docker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: false, Status: 'exited', ExitCode: 0 },
			}),
			containerLogs: vi.fn().mockResolvedValue(null),
		});
		const status = await syncContainerStatus(db, docker, id, 'slug', 'cid', 'running');
		expect(status).toBe('stopped');
		const row = await db.query<{ container_error: string | null }>(
			'SELECT container_error FROM projects WHERE id = $1',
			[id],
		);
		expect(row.rows[0].container_error).toContain('Container stopped (exited)');
	});
});
