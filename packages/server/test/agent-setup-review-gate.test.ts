import { CAPTAIN_AGENT_SLUG, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;

/** The team's open setup / coherence review, or null when none is filed. */
async function openCoherenceTask(
	team: string,
): Promise<{ id: string; identifier: string; assignee_id: string | null } | null> {
	const r = await db.query<{ id: string; identifier: string; assignee_id: string | null }>(
		`SELECT id, identifier, assignee_id FROM tasks
		  WHERE team_id = $1 AND labels @> '["team-coherence-review"]'::jsonb
		    AND status NOT IN ('done'::task_status, 'cancelled'::task_status)
		  ORDER BY created_at DESC LIMIT 1`,
		[team],
	);
	return r.rows[0] ?? null;
}

async function setupReviewPointer(agentId: string): Promise<string | null> {
	const r = await db.query<{ setup_review_task_id: string | null }>(
		'SELECT setup_review_task_id FROM member_agents WHERE id = $1',
		[agentId],
	);
	return r.rows[0]?.setup_review_task_id ?? null;
}

async function agentIdBySlug(team: string, slug: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		  WHERE m.team_id = $1 AND ma.slug = $2`,
		[team, slug],
	);
	return r.rows[0].id;
}

/** Create an agent through the admin's Add-agent route and return its member id. */
async function addAgent(project: string, title: string): Promise<string> {
	const res = await app.request(`/api/projects/${project}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, system_prompt: compliantPrompt(`You are the ${title}.`) }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
}

async function createTask(
	project: string,
	title: string,
	assigneeId: string,
): Promise<Record<string, unknown>> {
	const res = await app.request(`/api/projects/${project}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, assignee_id: assigneeId }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	teamId = (await (await createTestTeam(db, { name: 'Gate Co' })).json()).data.id;
	projectSlug = (await (await createTestProject(db, teamId, { name: 'Gate' })).json()).data.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('a new agent’s tasks are gated on its team setup review', () => {
	let reviewTaskId: string;
	let newAgentId: string;

	it('stamps the auto-created setup review onto the newly added agent', async () => {
		newAgentId = await addAgent(projectSlug, 'Data Scientist');

		const review = await openCoherenceTask(teamId);
		expect(review).not.toBeNull();
		reviewTaskId = (review as { id: string }).id;

		expect(await setupReviewPointer(newAgentId)).toBe(reviewTaskId);
	});

	it('never stamps the review’s own assignee, so no agent is gated on its own review', async () => {
		const review = await openCoherenceTask(teamId);
		const assigneeId = (review as { assignee_id: string | null }).assignee_id;
		expect(assigneeId).not.toBeNull();
		expect(await setupReviewPointer(assigneeId as string)).toBeNull();
	});

	it('blocks a task created for the new agent on that review', async () => {
		const task = await createTask(projectSlug, 'Draft the model spec', newAgentId);
		expect(task.status).toBe(TaskStatus.Blocked);

		const deps = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/dependencies`, {
			headers: authHeader(token),
		});
		expect(deps.status).toBe(200);
		const blockers = (await deps.json()).data as Array<{ blocked_by_task_id: string }>;
		expect(blockers.map((b) => b.blocked_by_task_id)).toContain(reviewTaskId);
	});

	it('leaves a task for an established agent unblocked', async () => {
		const captainId = await agentIdBySlug(teamId, CAPTAIN_AGENT_SLUG);
		// The Captain predates the review and was never stamped.
		expect(await setupReviewPointer(captainId)).toBeNull();

		const task = await createTask(projectSlug, 'Routine planning check', captainId);
		expect(task.status).toBe(TaskStatus.Backlog);
	});

	it('coalesces a second hire onto the same open review and stamps it too', async () => {
		const secondAgentId = await addAgent(projectSlug, 'Research Analyst');
		expect(await setupReviewPointer(secondAgentId)).toBe(reviewTaskId);

		const task = await createTask(projectSlug, 'Survey the field', secondAgentId);
		expect(task.status).toBe(TaskStatus.Blocked);
	});

	it('unblocks the gated tasks and wakes their assignees when the review closes', async () => {
		const gated = await db.query<{ id: string; assignee_id: string }>(
			`SELECT i.id, i.assignee_id FROM tasks i
			   JOIN task_dependencies d ON d.task_id = i.id
			  WHERE d.blocked_by_task_id = $1`,
			[reviewTaskId],
		);
		expect(gated.rows.length).toBeGreaterThan(0);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${reviewTaskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: TaskStatus.Done }),
		});
		expect(res.status).toBe(200);

		for (const row of gated.rows) {
			const after = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
				row.id,
			]);
			expect(after.rows[0].status).toBe(TaskStatus.Backlog);

			const wake = await db.query(
				`SELECT id FROM agent_wakeup_requests
				  WHERE member_id = $1 AND payload->>'task_id' = $2 AND status = 'queued'`,
				[row.assignee_id, row.id],
			);
			expect(wake.rows.length).toBeGreaterThan(0);
		}
	});

	it('stops gating once the review is terminal, without clearing the pointer', async () => {
		// The pointer stays as the record of which review onboarded the agent...
		expect(await setupReviewPointer(newAgentId)).toBe(reviewTaskId);
		// ...but a task filed now is no longer blocked.
		const task = await createTask(projectSlug, 'Post-setup work', newAgentId);
		expect(task.status).toBe(TaskStatus.Backlog);
	});

	it('does not re-gate an already-stamped agent when a later review opens', async () => {
		// Adding another agent files a fresh review; the earlier agent keeps its
		// original (now closed) pointer and is not dragged back into blocked.
		const thirdAgentId = await addAgent(projectSlug, 'Ops Specialist');
		const later = await openCoherenceTask(teamId);
		expect((later as { id: string }).id).not.toBe(reviewTaskId);

		expect(await setupReviewPointer(newAgentId)).toBe(reviewTaskId);
		const task = await createTask(projectSlug, 'Still unblocked', newAgentId);
		expect(task.status).toBe(TaskStatus.Backlog);

		// The genuinely new agent is gated on the new review.
		expect(await setupReviewPointer(thirdAgentId)).toBe((later as { id: string }).id);
		const gated = await createTask(projectSlug, 'Ops onboarding work', thirdAgentId);
		expect(gated.status).toBe(TaskStatus.Blocked);
	});
});

describe('a freshly provisioned roster is gated on the initial team setup task', () => {
	let freshProjectSlug: string;
	let freshTeamId: string;

	beforeAll(async () => {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Fresh Roster Co',
				description: 'A brand new project-team.',
			}),
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;
		freshProjectSlug = project.slug;
		freshTeamId = project.team_id;
	});

	it('stamps every roster agent except the setup task’s own assignee', async () => {
		const setup = await openCoherenceTask(freshTeamId);
		expect(setup).not.toBeNull();
		const setupId = (setup as { id: string }).id;

		const roster = await db.query<{ id: string; setup_review_task_id: string | null }>(
			`SELECT ma.id, ma.setup_review_task_id FROM member_agents ma
			   JOIN members m ON m.id = ma.id WHERE m.team_id = $1`,
			[freshTeamId],
		);
		expect(roster.rows.length).toBeGreaterThan(0);
		for (const agent of roster.rows) {
			expect(agent.setup_review_task_id).toBe(setupId);
		}

		// The setup pass is owned by the CEO, who lives in HQ - never on this roster.
		const assigneeId = (setup as { assignee_id: string | null }).assignee_id;
		expect(roster.rows.map((a) => a.id)).not.toContain(assigneeId);
	});

	it('blocks a task filed for a roster agent on the setup task', async () => {
		const captainId = await agentIdBySlug(freshTeamId, CAPTAIN_AGENT_SLUG);
		const task = await createTask(freshProjectSlug, 'Early work', captainId);
		expect(task.status).toBe(TaskStatus.Blocked);
	});
});
