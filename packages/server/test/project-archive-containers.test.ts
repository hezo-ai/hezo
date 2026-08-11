import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntimeStatus, WakeupStatus } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { ContainerLogStreamer } from '../src/services/container-logs';
import {
	acquireRunContainer,
	type ContainerDeps,
	ProjectArchivedError,
} from '../src/services/containers';
import type { ContainerEngine } from '../src/services/docker';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { upsertPoolMember } from '../src/services/sandbox/pool-db';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';

// Archiving a project has to retire it, not merely hide it. It used to stop only
// the container `projects.container_id` named, leaving that container as a
// `suspended` pool member - which is a *resume* rung on the pool ladder, so the
// next heartbeat brought it straight back, and in the meantime it sat on the
// global Containers page reading "Stopped" with nothing able to reap it.

let ctx: Awaited<ReturnType<typeof createTestApp>>;

/**
 * Containers the engine was asked to remove, in call order.
 *
 * One recording engine is handed to `createTestApp`, so the archive route's own
 * teardown lands here too - asserting on the DB alone would not prove the
 * container was actually removed from the backend, which is the half that costs
 * money on a managed one.
 */
let removedContainers: string[];
let docker: ContainerEngine;

function containerDeps(): ContainerDeps {
	return { db: ctx.db, docker, dataDir: ctx.dataDir };
}

function createJobManager(overrides: Partial<JobManagerDeps> = {}): JobManager {
	return new JobManager({
		db: ctx.db,
		docker,
		masterKeyManager: ctx.masterKeyManager,
		serverPort: 0,
		dataDir: ctx.dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
		...overrides,
	});
}

/** Typed access to JobManager's dispatch internals, as the other JM suites do. */
interface JmInternals {
	activateAgent(
		memberId: string,
		teamId: string,
		wakeupId: string | undefined,
		payload: Record<string, unknown>,
		source: string,
	): Promise<void>;
}

interface Fixture {
	teamId: string;
	projectId: string;
	projectSlug: string;
	captainId: string;
}

let counter = 0;

/** A fresh team + project per test, so archiving one cannot leak into the next. */
async function newProject(name: string): Promise<Fixture> {
	counter += 1;
	const typesRes = await ctx.app.request('/api/team-templates', {
		headers: authHeader(ctx.token),
	});
	const typeId = (await typesRes.json()).data.find((t: { name: string }) => t.name === 'Blank').id;
	const teamRes = await createTestTeam(ctx.db, {
		name: `${name} Co ${counter}`,
		template_id: typeId,
	});
	const teamId = (await teamRes.json()).data.id as string;

	const projectRes = await createTestProject(ctx.db, teamId, { name: `${name} ${counter}` });
	const project = (await projectRes.json()).data;

	const captain = await ctx.db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);

	return {
		teamId,
		projectId: project.id as string,
		projectSlug: project.slug as string,
		captainId: captain.rows[0].id,
	};
}

async function archive(slug: string): Promise<Response> {
	return ctx.app.request(`/api/projects/${slug}/archive`, {
		method: 'POST',
		headers: authHeader(ctx.token),
	});
}

/** Give a project `n` pool members plus a named container, as a live one has. */
async function giveContainers(
	projectId: string,
	ids: string[],
	opts: { nameOne?: boolean } = {},
): Promise<void> {
	for (const id of ids) await upsertPoolMember(ctx.db, projectId, id, 'idle');
	if (opts.nameOne !== false) {
		await ctx.db.query(
			`UPDATE projects SET container_id = $1, container_status = 'running'::container_status
			 WHERE id = $2`,
			[ids[0], projectId],
		);
	}
}

async function poolMemberIds(projectId: string): Promise<string[]> {
	const r = await ctx.db.query<{ container_id: string }>(
		'SELECT container_id FROM container_pool_members WHERE project_id = $1 ORDER BY container_id',
		[projectId],
	);
	return r.rows.map((row) => row.container_id);
}

async function namedContainer(projectId: string): Promise<string | null> {
	const r = await ctx.db.query<{ container_id: string | null }>(
		'SELECT container_id FROM projects WHERE id = $1',
		[projectId],
	);
	return r.rows[0].container_id;
}

beforeAll(async () => {
	removedContainers = [];
	docker = createStubDocker({
		removeContainer: async (id: string) => {
			removedContainers.push(id);
		},
	});
	ctx = await createTestApp({ docker });
});

beforeEach(() => {
	removedContainers.length = 0;
});

afterAll(async () => {
	await safeClose(ctx.db);
});

describe('archiving a project retires its containers', () => {
	it('removes every pool member, not just the one the project names', async () => {
		const p = await newProject('Two Members');
		await giveContainers(p.projectId, ['arch-a-1', 'arch-a-2']);

		expect((await archive(p.projectSlug)).status).toBe(200);
		await waitForBackground();

		expect(removedContainers.sort()).toEqual(['arch-a-1', 'arch-a-2']);
		expect(await poolMemberIds(p.projectId)).toEqual([]);
		expect(await namedContainer(p.projectId)).toBeNull();
	});

	it('tears down pool members even when the project names no container', async () => {
		// `clearProjectContainerIfNamed` nulls `container_id` whenever the named
		// container is destroyed, so this state is reachable with members still
		// live. The old handler gated every side effect on that column and so did
		// nothing at all here.
		const p = await newProject('Unnamed');
		await giveContainers(p.projectId, ['arch-b-1'], { nameOne: false });
		await ctx.db.query('UPDATE projects SET container_id = NULL WHERE id = $1', [p.projectId]);

		expect((await archive(p.projectSlug)).status).toBe(200);
		await waitForBackground();

		expect(removedContainers).toEqual(['arch-b-1']);
		expect(await poolMemberIds(p.projectId)).toEqual([]);
	});

	it('keeps the workspace, because unarchiving has to find the repo clone', async () => {
		const p = await newProject('Keep Workspace');
		await giveContainers(p.projectId, ['arch-c-1']);

		const workspace = join(ctx.dataDir, 'workspaces', p.teamId, p.projectId);
		mkdirSync(workspace, { recursive: true });
		const marker = join(workspace, 'unpushed.txt');
		writeFileSync(marker, 'work an agent has not pushed yet');

		expect((await archive(p.projectSlug)).status).toBe(200);
		await waitForBackground();

		expect(await poolMemberIds(p.projectId)).toEqual([]);
		expect(existsSync(marker)).toBe(true);
	});

	it('drops the project off the global Containers list', async () => {
		const p = await newProject('Listing');
		await giveContainers(p.projectId, ['arch-d-1', 'arch-d-2']);

		const before = await ctx.app.request('/api/containers', { headers: authHeader(ctx.token) });
		const beforeRows = (await before.json()).data as Array<{ project_id: string }>;
		expect(beforeRows.filter((r) => r.project_id === p.projectId)).toHaveLength(2);

		await archive(p.projectSlug);
		await waitForBackground();

		const after = await ctx.app.request('/api/containers', { headers: authHeader(ctx.token) });
		const afterRows = (await after.json()).data as Array<{ project_id: string }>;
		expect(afterRows.filter((r) => r.project_id === p.projectId)).toHaveLength(0);
	});
});

describe('an archived project is never given a container', () => {
	it('acquireRunContainer refuses it rather than resuming one', async () => {
		const p = await newProject('No Acquire');
		await ctx.db.query('UPDATE projects SET archived_at = now() WHERE id = $1', [p.projectId]);

		await expect(acquireRunContainer(containerDeps(), p.projectId, null)).rejects.toThrow(
			ProjectArchivedError,
		);
	});

	it('a heartbeat finds no actionable task and dispatches no run', async () => {
		const p = await newProject('No Heartbeat');
		const taskRes = await ctx.app.request(`/api/projects/${p.projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Still open', assignee_id: p.captainId }),
		});
		expect(taskRes.status).toBe(201);
		await waitForBackground();

		await ctx.db.query('UPDATE projects SET archived_at = now() WHERE id = $1', [p.projectId]);
		await ctx.db.query('UPDATE member_agents SET last_heartbeat_at = NULL WHERE id = $1', [
			p.captainId,
		]);

		const manager = createJobManager();
		await (manager as unknown as JmInternals).activateAgent(
			p.captainId,
			p.teamId,
			undefined,
			{ reason: 'scheduled_heartbeat' },
			'heartbeat',
		);
		manager.shutdown();
		await waitForBackground();

		const runs = await ctx.db.query('SELECT id FROM heartbeat_runs WHERE team_id = $1', [p.teamId]);
		expect(runs.rows).toHaveLength(0);

		// The no-actionable-tasks branch stamps the heartbeat, so the scheduler
		// throttles this agent instead of re-selecting it every tick.
		const agent = await ctx.db.query<{ last_heartbeat_at: string | null }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[p.captainId],
		);
		expect(agent.rows[0].last_heartbeat_at).not.toBeNull();
	});

	it('a wakeup naming a task in an archived project completes without dispatching', async () => {
		const p = await newProject('No Payload Wake');
		const taskRes = await ctx.app.request(`/api/projects/${p.projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Mentioned', assignee_id: p.captainId }),
		});
		const taskId = (await taskRes.json()).data.id as string;
		await waitForBackground();

		await ctx.db.query('UPDATE projects SET archived_at = now() WHERE id = $1', [p.projectId]);
		await ctx.db.query(
			`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
			[AgentRuntimeStatus.Idle, p.captainId],
		);

		const wakeup = await ctx.db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, 'mention'::wakeup_source, 'claimed'::wakeup_status, $3::jsonb)
			 RETURNING id`,
			[p.captainId, p.teamId, JSON.stringify({ task_id: taskId })],
		);

		const manager = createJobManager();
		await (manager as unknown as JmInternals).activateAgent(
			p.captainId,
			p.teamId,
			wakeup.rows[0].id,
			{ task_id: taskId },
			'mention',
		);
		manager.shutdown();
		await waitForBackground();

		const row = await ctx.db.query<{ status: string }>(
			'SELECT status::text AS status FROM agent_wakeup_requests WHERE id = $1',
			[wakeup.rows[0].id],
		);
		expect(row.rows[0].status).toBe(WakeupStatus.Completed);
		const runs = await ctx.db.query('SELECT id FROM heartbeat_runs WHERE team_id = $1', [p.teamId]);
		expect(runs.rows).toHaveLength(0);
	});
});

describe('startup retirement of already-archived projects', () => {
	it('tears down containers an older archive left suspended', async () => {
		// Exactly the state the previous behaviour left behind: archived, still
		// naming a container, with a `suspended` member nothing would ever reap.
		const p = await newProject('Legacy Archive');
		await upsertPoolMember(ctx.db, p.projectId, 'legacy-1', 'suspended');
		await ctx.db.query(
			`UPDATE projects
			 SET archived_at = now(), container_id = 'legacy-1',
			     container_status = 'stopped'::container_status
			 WHERE id = $1`,
			[p.projectId],
		);

		const manager = createJobManager();
		await manager.reconcileOnStartup();
		manager.shutdown();
		await waitForBackground();

		expect(removedContainers).toContain('legacy-1');
		expect(await poolMemberIds(p.projectId)).toEqual([]);
		expect(await namedContainer(p.projectId)).toBeNull();
	});
});
