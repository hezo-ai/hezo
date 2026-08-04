import { CHAT_IDLE_TIMEOUT_MIN, CONTAINER_IDLE_TIMEOUT_MIN } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
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

/**
 * A staleness comfortably *inside* the idle window, derived from the constant
 * rather than written as a number.
 *
 * These fixtures used to say "5 minutes", which was inside the old configurable
 * 15-minute default and is outside the fixed 2-minute one - so a hardcoded
 * figure would have silently inverted what each test asserts the moment the
 * window changed, rather than failing.
 */
const INSIDE_WINDOW_MIN = Math.max(1, CONTAINER_IDLE_TIMEOUT_MIN - 1);

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

function createManager(stops: string[], removes: string[] = []): JobManager {
	return new JobManager({
		db,
		docker: createStubDocker({
			ping: async () => true,
			stopContainer: async (id: string) => {
				stops.push(id);
			},
			removeContainer: async (id: string) => {
				removes.push(id);
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
	// Reset to "running and idle for an hour"; each test then adds exactly one
	// busy signal. The window itself is the CONTAINER_IDLE_TIMEOUT_MIN constant,
	// so "inside the window" below is expressed relative to it rather than to a
	// number a test could set - which is the point of it no longer being a
	// setting.
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

	it('never stops a container inside its first idle window (start-time floor)', async () => {
		await db.query(
			`UPDATE projects SET container_last_started_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
			[projectId, INSIDE_WINDOW_MIN],
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
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now(),
			         now() - ($4 || ' minutes')::interval)`,
			[agentId, teamId, taskId, INSIDE_WINDOW_MIN],
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

	it('a chat pause holds the container well past the run window', async () => {
		// The two windows measure different things. Between runs the gap is
		// mechanical and two minutes covers it; between chat messages it is a person
		// reading a reply, and reclaiming there suspended the container out from
		// under an open chatbox so the next message paid a cold start.
		await db.query(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status, last_activity_at)
			 VALUES ($1, $2, $3, 'claude_code', 'running', now() - interval '5 minutes')`,
			[agentId, teamId, projectId],
		);
		// Comfortably past CONTAINER_IDLE_TIMEOUT_MIN, comfortably inside
		// CHAT_IDLE_TIMEOUT_MIN.
		expect(CONTAINER_IDLE_TIMEOUT_MIN).toBeLessThan(5);
		expect(CHAT_IDLE_TIMEOUT_MIN).toBeGreaterThan(5);
		expect((await runIdlePass()).stops).toEqual([]);
	});

	it('parks a live assistant session before taking its container down', async () => {
		// Ordering, and it is the whole point: suspending first meant the session
		// found out by its tunnel dying - the unrequested-death path - so it ended
		// as `crashed` rather than parking as `suspended`, and the provider's PTY
		// delete raced the sandbox already stopping and 400'd.
		const parked: string[] = [];
		const order: string[] = [];
		const stops: string[] = [];
		const manager = new JobManager({
			db,
			docker: createStubDocker({
				ping: async () => true,
				stopContainer: async (id: string) => {
					order.push(`stop:${id}`);
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
		manager.setChatSessions({
			parkForContainerSuspend: async (id: string) => {
				order.push(`park:${id}`);
				parked.push(id);
			},
		});

		await (manager as unknown as { stopIdleContainers(): Promise<void> }).stopIdleContainers();
		manager.shutdown();

		expect(parked).toEqual([CONTAINER_ID]);
		expect(order).toEqual([`park:${CONTAINER_ID}`, `stop:${CONTAINER_ID}`]);
	});

	it('retires the pool even when parking the assistant session fails', async () => {
		// Best-effort: a park that throws must not strand a container that is
		// otherwise idle, or one failure bills forever on a managed backend.
		const stops: string[] = [];
		const manager = createManager(stops);
		manager.setChatSessions({
			parkForContainerSuspend: async () => {
				throw new Error('chat manager is wedged');
			},
		});
		await (manager as unknown as { stopIdleContainers(): Promise<void> }).stopIdleContainers();
		manager.shutdown();
		expect(stops).toContain(CONTAINER_ID);
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

	it('suspends one idle container and destroys the surplus', async () => {
		// At most one suspended container per project - exactly the cardinality a
		// single-container project had. That one rule is what removes a retention
		// cap, a reap horizon and snapshot storage to watch grow; the price is that
		// the second and later containers of a burst are always created cold.
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state) VALUES
			   ($1, 'pool-a', 'idle'), ($1, 'pool-b', 'idle'), ($1, 'pool-c', 'idle')`,
			[projectId],
		);
		await db.query(
			`UPDATE projects SET container_status = 'running',
			        container_last_started_at = now() - interval '60 minutes' WHERE id = $1`,
			[projectId],
		);
		const stops: string[] = [];
		const removes: string[] = [];
		const manager = createManager(stops, removes);
		await (manager as unknown as { stopIdleContainers(): Promise<void> }).stopIdleContainers();
		manager.shutdown();

		expect(stops).toHaveLength(1);
		expect(removes).toHaveLength(2);
		expect([...stops, ...removes].sort()).toEqual(['pool-a', 'pool-b', 'pool-c']);

		const rows = await db.query<{ container_id: string; state: string }>(
			`SELECT container_id, state::text AS state FROM container_pool_members WHERE project_id = $1`,
			[projectId],
		);
		// The destroyed members are gone from the table, not left as tombstones the
		// ladder would have to keep skipping.
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0]).toMatchObject({ container_id: stops[0], state: 'suspended' });
		await db.query(`DELETE FROM container_pool_members WHERE project_id = $1`, [projectId]);
	});

	it('never destroys a container holding commits that reached no durable remote', async () => {
		// The work exists nowhere else and nothing downstream would report that it
		// had gone - so the pin outranks *destruction*. It deliberately does not
		// outrank suspension: stopping preserves the writable layer, so the
		// commits survive, while leaving the container running would hold its full
		// RAM cap out of the global budget until some later run on that same
		// container clears the flag. The pinned member is therefore the one that
		// takes the single suspend slot.
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state, has_unpushed_commits)
			 VALUES ($1, 'pool-pinned', 'idle', true), ($1, 'pool-free', 'idle', false)`,
			[projectId],
		);
		await db.query(
			`UPDATE projects SET container_status = 'running',
			        container_last_started_at = now() - interval '60 minutes' WHERE id = $1`,
			[projectId],
		);
		const stops: string[] = [];
		const removes: string[] = [];
		const manager = createManager(stops, removes);
		await (manager as unknown as { stopIdleContainers(): Promise<void> }).stopIdleContainers();
		manager.shutdown();

		// Never destroyed - that is the half that would lose the work.
		expect(removes).not.toContain('pool-pinned');
		// Suspended rather than left running, and the unpinned surplus is the one
		// that gets removed.
		expect(stops).toEqual(['pool-pinned']);
		expect(removes).toContain('pool-free');
		await db.query(`DELETE FROM container_pool_members WHERE project_id = $1`, [projectId]);
	});
});
