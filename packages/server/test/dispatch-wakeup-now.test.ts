import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { ContainerLogStreamer } from '../src/services/container-logs';
import type { DockerClient } from '../src/services/docker';
import { JobManager } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;

const json = { 'Content-Type': 'application/json' };

// A complete docker mock whose exec calls succeed, so a launched runAgent
// completes cleanly rather than throwing (the default test stub's execCreate
// throws on purpose).
function createMockDocker(): DockerClient {
	return {
		ping: async () => true,
		imageExists: async () => true,
		pullImage: async () => {},
		createContainer: async () => ({ Id: 'container-123', Warnings: [] }),
		startContainer: async () => {},
		stopContainer: async () => {},
		removeContainer: async () => {},
		inspectContainer: async () => ({
			Id: 'container-123',
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'test' },
		}),
		containerLogs: async () => new ReadableStream(),
		execCreate: async () => 'exec-123',
		execStart: async () => ({ stdout: 'done', stderr: '' }),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
	} as unknown as DockerClient;
}

function createJobManager(): JobManager {
	return new JobManager({
		db,
		docker: createMockDocker(),
		masterKeyManager,
		serverPort: 3100,
		dataDir,
		wsManager: { broadcast: () => {} } as any,
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ name: 'Dispatch Now Co', template_id: typeId }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Dispatch Project',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ project_id: projectId, title: 'Dispatch Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;

	// Pass activateAgent's designated-repo gate and container check so a run can
	// actually launch.
	const repoRes = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
		 VALUES ($1, 'test', 'test-org/test-repo', 'github'::repo_host_type)
		 RETURNING id`,
		[projectId],
	);
	await db.query(
		`UPDATE projects
		 SET designated_repo_id = $1, container_id = 'test-container', container_status = 'running'
		 WHERE id = $2`,
		[repoRes.rows[0].id, projectId],
	);

	// Let the fire-and-forget assignment wakeup from task creation settle.
	await new Promise((r) => setTimeout(r, 50));
	await db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		taskId,
	]);
});

afterEach(async () => {
	// Drain in-flight launchTask (background runAgent) promises before teardown.
	await waitForBackground();
});

afterAll(async () => {
	await safeClose(db);
});

async function insertQueuedWakeup(memberId: string, source = 'mention'): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
		 VALUES ($1, $2, $3::wakeup_source, 'queued'::wakeup_status,
		         jsonb_build_object('task_id', $4::text))
		 RETURNING id`,
		[memberId, teamId, source, taskId],
	);
	return r.rows[0].id;
}

describe('JobManager.dispatchWakeupNow', () => {
	it('launches the run immediately and creates a heartbeat run for the task', async () => {
		const manager = createJobManager();
		const wakeupId = await insertQueuedWakeup(agentId);

		const result = await manager.dispatchWakeupNow(wakeupId);
		expect(result.dispatched).toBe(true);

		// Drain the background run so createHeartbeatRun has landed.
		await waitForBackground();

		const runs = await db.query<{ id: string }>(
			'SELECT id FROM heartbeat_runs WHERE task_id = $1',
			[taskId],
		);
		expect(runs.rows.length).toBeGreaterThan(0);

		const wakeup = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(wakeup.rows[0].status).not.toBe('queued');
	});

	it('returns not_found for an unknown wakeup id', async () => {
		const manager = createJobManager();
		const result = await manager.dispatchWakeupNow('00000000-0000-0000-0000-000000000000');
		expect(result).toEqual({ dispatched: false, reason: 'not_found' });
	});

	it('returns not_queued for an already-claimed wakeup', async () => {
		const manager = createJobManager();
		const wakeupId = await insertQueuedWakeup(agentId);
		await db.query(
			"UPDATE agent_wakeup_requests SET status = 'claimed'::wakeup_status WHERE id = $1",
			[wakeupId],
		);
		const result = await manager.dispatchWakeupNow(wakeupId);
		expect(result).toEqual({ dispatched: false, reason: 'not_queued' });
	});
});
