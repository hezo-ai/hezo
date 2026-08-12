import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * One agent, one task, three projections that name it: the task's assignee, the
 * execution lock the Agent Queue reads, and the queued wakeup beneath it. They
 * are separate queries, and they used to disagree - the sidebar showed "Riley"
 * while the queue directly above it showed "Market Researcher", because each had
 * inlined its own COALESCE. They all read `agentDisplayNameSql` now, so the
 * assertion is simply that they agree, whether or not the agent has a name.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let taskIdentifier: string;
let agentId: string;
let agentSlug: string;
let agentTitle: string;

async function labels(): Promise<{ assignee: string; lock: string; wakeup: string }> {
	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskIdentifier}`, {
		headers: authHeader(token),
	});
	const lockRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskIdentifier}/lock`, {
		headers: authHeader(token),
	});
	const wakeupRes = await app.request(
		`/api/projects/${projectSlug}/tasks/${taskIdentifier}/queued-wakeups`,
		{ headers: authHeader(token) },
	);
	return {
		assignee: (await taskRes.json()).data.assignee_name,
		lock: (await lockRes.json()).data.locks[0].member_name,
		wakeup: (await wakeupRes.json()).data.wakeups[0].member_name,
	};
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const templateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Label Parity Co', template_id: templateId });
	const teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Label Parity Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agent = (await agentsRes.json()).data[0];
	agentId = agent.id;
	agentSlug = agent.slug;
	agentTitle = agent.title;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Parity Task', assignee_id: agentId }),
	});
	const task = (await taskRes.json()).data;
	taskId = task.id;
	taskIdentifier = task.identifier.toLowerCase();

	// A running agent and a queued one, so all three projections have a row.
	await db.query(
		`INSERT INTO execution_locks (task_id, member_id, lock_type, locked_at)
		 VALUES ($1, $2, 'write', now())`,
		[taskId, agentId],
	);
	await db.query(
		`INSERT INTO agent_wakeup_requests (team_id, member_id, status, source, payload)
		 VALUES ($1, $2, 'queued', 'mention', jsonb_build_object('task_id', $3::text))`,
		[teamId, agentId, taskId],
	);
});

afterAll(async () => {
	await safeClose(db);
});

describe('an agent is labelled identically by every projection that names it', () => {
	it('agrees on the role while the agent is unnamed', async () => {
		const { assignee, lock, wakeup } = await labels();
		expect(assignee).toBe(agentTitle);
		expect(lock).toBe(agentTitle);
		expect(wakeup).toBe(agentTitle);
	});

	it('agrees on the name once the agent has one', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/${agentSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ human_name: 'Riley' }),
		});
		expect(res.status).toBe(200);

		const { assignee, lock, wakeup } = await labels();
		expect(assignee).toBe('Riley');
		expect(lock).toBe('Riley');
		expect(wakeup).toBe('Riley');
	});

	it('carries the role alongside the name, so the queue can show both', async () => {
		const lockRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskIdentifier}/lock`, {
			headers: authHeader(token),
		});
		const lock = (await lockRes.json()).data.locks[0];
		expect(lock.member_title).toBe(agentTitle);
		expect(lock.member_slug).toBe(agentSlug);
	});

	it('falls back to the role when the name is cleared', async () => {
		await app.request(`/api/projects/${projectSlug}/agents/${agentSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ human_name: '' }),
		});
		const { assignee, lock, wakeup } = await labels();
		expect(assignee).toBe(agentTitle);
		expect(lock).toBe(agentTitle);
		expect(wakeup).toBe(agentTitle);
	});
});
