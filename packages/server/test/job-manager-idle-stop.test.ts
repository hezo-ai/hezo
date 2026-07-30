import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { CONTAINER_IDLE_TIMEOUT_KEY, setSystemMeta } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';

let db: Db;
let app: Hono<Env>;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let agentId: string;
let taskId: string;

const CONTAINER_ID = 'idle-box';

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Idle Stop Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Idle Stop Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;

	const agent = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 LIMIT 1`,
		[teamId],
	);
	agentId = agent.rows[0].id;

	const taskRes = await app.request(`/api/projects/${project.slug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'content-type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Idle-stop probe task',
			assignee_id: agentId,
		}),
	});
	const taskBody = await taskRes.json();
	if (!taskRes.ok) throw new Error(`task create failed: ${JSON.stringify(taskBody)}`);
	taskId = taskBody.data.id;
});

afterAll(async () => {
	await safeClose(db);
});

function createManager(stops: string[]): JobManager {
	return new JobManager({
		db,
		docker: createStubDocker({
			ping: async () => true,
			stopContainer: async (id: string) => {
				stops.push(id);
			},
		}),
		masterKeyManager,
		serverPort: 3100,
		dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
	});
}

async function runIdlePass(): Promise<{ stops: string[]; manager: JobManager }> {
	const stops: string[] = [];
	const manager = createManager(stops);
	await (manager as unknown as { stopIdleContainers(): Promise<void> }).stopIdleContainers();
	manager.shutdown();
	return { stops, manager };
}

async function containerStatus(): Promise<string | null> {
	const r = await db.query<{ container_status: string | null }>(
		'SELECT container_status FROM projects WHERE id = $1',
		[projectId],
	);
	return r.rows[0].container_status;
}

beforeEach(async () => {
	// Reset to "running and idle for an hour" with a 15-minute timeout; each
	// test then adds exactly one busy signal (or changes the timeout).
	await setSystemMeta(db, CONTAINER_IDLE_TIMEOUT_KEY, '15');
	await db.query(
		`UPDATE projects
		 SET container_id = $2, container_status = 'running', container_error = NULL,
		     container_last_started_at = now() - interval '60 minutes'
		 WHERE id = $1`,
		[projectId, CONTAINER_ID],
	);
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
	await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
	await db.query(
		'DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE team_id = $1)',
		[teamId],
	);
	await db.query('DELETE FROM chat_sessions WHERE team_id = $1', [teamId]);
	await db.query('DELETE FROM chat_conversations WHERE team_id = $1', [teamId]);
});

describe('container-idle-stop', () => {
	it('stops a container idle past the timeout and marks the project stopped', async () => {
		const { stops } = await runIdlePass();
		expect(stops).toContain(CONTAINER_ID);
		expect(await containerStatus()).toBe('stopped');
	});

	it('a timeout of 0 disables the reaper entirely', async () => {
		await setSystemMeta(db, CONTAINER_IDLE_TIMEOUT_KEY, '0');
		const { stops } = await runIdlePass();
		expect(stops).toEqual([]);
		expect(await containerStatus()).toBe('running');
	});

	it('never stops a container inside its first idle window (start-time floor)', async () => {
		await db.query(
			`UPDATE projects SET container_last_started_at = now() - interval '5 minutes' WHERE id = $1`,
			[projectId],
		);
		const { stops } = await runIdlePass();
		expect(stops).toEqual([]);
		expect(await containerStatus()).toBe('running');
	});

	it('an active (queued/running) run holds the container up', async () => {
		await db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())`,
			[agentId, teamId, taskId],
		);
		const { stops } = await runIdlePass();
		expect(stops).toEqual([]);
		expect(await containerStatus()).toBe('running');
	});

	it('a run finished inside the idle window holds the container up; an old one does not', async () => {
		await db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now(), now() - interval '5 minutes')`,
			[agentId, teamId, taskId],
		);
		expect((await runIdlePass()).stops).toEqual([]);

		await db.query(
			`UPDATE heartbeat_runs SET finished_at = now() - interval '60 minutes' WHERE team_id = $1`,
			[teamId],
		);
		expect((await runIdlePass()).stops).toContain(CONTAINER_ID);
	});

	it('a queued wakeup that could dispatch holds the container up', async () => {
		await db.query(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
			         jsonb_build_object('task_id', $3::text))`,
			[agentId, teamId, taskId],
		);
		const { stops } = await runIdlePass();
		expect(stops).toEqual([]);
	});

	it('a capacity-skipped wakeup does NOT hold the container (its backlog is what the cap waits on)', async () => {
		await db.query(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, last_skipped_at, last_skipped_reason)
			 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
			         jsonb_build_object('task_id', $3::text), now(), 'instance_at_capacity')`,
			[agentId, teamId, taskId],
		);
		const { stops } = await runIdlePass();
		expect(stops).toContain(CONTAINER_ID);
	});

	it('a run-limit-skipped wakeup DOES hold the container (it dispatches into this same one)', async () => {
		// The inverse of the container-capacity case above, and the reason
		// 'project_at_run_limit' is deliberately absent from BUSY_PROJECTS_SQL's
		// exclusion list: a run-limit skip is only reachable when this project
		// already has an active run, so its container is legitimately in use and
		// the wakeup dispatches into that same warm container as a slot frees.
		await db.query(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, last_skipped_at, last_skipped_reason)
			 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
			         jsonb_build_object('task_id', $3::text), now(), 'project_at_run_limit')`,
			[agentId, teamId, taskId],
		);
		const { stops } = await runIdlePass();
		expect(stops).toEqual([]);
	});

	it('a chat session with recent activity holds the container; a stale one does not', async () => {
		const conversation = await db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, title)
			 VALUES ($1, $2, $3, 'Idle chat') RETURNING id`,
			[agentId, teamId, projectId],
		);
		await db.query(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status, last_activity_at)
			 VALUES ($1, $2, $3, 'claude_code', 'running', now())`,
			[agentId, teamId, projectId],
		);
		expect((await runIdlePass()).stops).toEqual([]);

		// The session alone doesn't pin the container once its activity is stale.
		await db.query(
			`UPDATE chat_sessions SET last_activity_at = now() - interval '60 minutes' WHERE team_id = $1`,
			[teamId],
		);
		expect((await runIdlePass()).stops).toContain(CONTAINER_ID);

		// …unless a turn is still in flight (pending/streaming message).
		await db.query(
			`UPDATE projects SET container_status = 'running', container_last_started_at = now() - interval '60 minutes' WHERE id = $1`,
			[projectId],
		);
		const session = await db.query<{ id: string }>(
			`SELECT id FROM chat_sessions WHERE team_id = $1 LIMIT 1`,
			[teamId],
		);
		await db.query(
			`INSERT INTO chat_messages (conversation_id, role, status, content, session_id)
			 VALUES ($1, 'assistant', 'streaming', '', $2)`,
			[conversation.rows[0].id, session.rows[0].id],
		);
		expect((await runIdlePass()).stops).toEqual([]);
	});

	it('the in-memory dispatch recheck blocks a stop even before any run row exists', async () => {
		const stops: string[] = [];
		const manager = createManager(stops);
		// Simulate a dispatch that has acquired its slot but not yet created the
		// heartbeat_runs row — the exact window the under-lock recheck closes.
		(manager as unknown as { acquireProjectRun(id: string): void }).acquireProjectRun(projectId);
		await (manager as unknown as { stopIdleContainers(): Promise<void> }).stopIdleContainers();
		expect(stops).toEqual([]);
		expect(await containerStatus()).toBe('running');
		manager.shutdown();
	});
});
