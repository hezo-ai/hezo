import type { PGlite } from '@electric-sql/pglite';
import { ActionCommentKind, ApprovalStatus, MemberType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	insertHireProposalComment,
	resolveHireProposalCommentAndWake,
} from '../src/services/hire-proposal-comment';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;

const json = { 'Content-Type': 'application/json' };

async function createAgent(title: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ title }),
	});
	return (await res.json()).data.id;
}

async function createTask(title: string, assigneeId: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ project_id: projectId, title, assignee_id: assigneeId }),
	});
	return (await res.json()).data.id;
}

/** A human (board-user) member on the team — never an agent. */
async function createHumanMember(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, $2, 'A Human') RETURNING id`,
		[teamId, MemberType.User],
	);
	return r.rows[0].id;
}

async function insertApproval(
	payload: Record<string, unknown>,
	requestedBy: string | null,
): Promise<Record<string, unknown>> {
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO approvals (team_id, type, status, payload, requested_by_member_id)
		 VALUES ($1, 'hire', 'pending', $2::jsonb, $3)
		 RETURNING *`,
		[teamId, JSON.stringify(payload), requestedBy],
	);
	return r.rows[0];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Hire Comment Co' });
	teamId = (await teamRes.json()).data.id;
	const projRes = await createTestProject(db, teamId, { name: 'Main', description: 'x' });
	projectId = (await projRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('insertHireProposalComment', () => {
	it('inserts a pending hire_proposal action comment with the spec snapshot', async () => {
		const agent = await createAgent('Snap Bot');
		const task = await createTask('Snapshot Task', agent);
		const approval = await insertApproval({ task_id: task }, agent);

		const row = await insertHireProposalComment(db, {
			taskId: task,
			approvalId: approval.id as string,
			payload: {
				title: 'Data Scientist',
				slug: 'data-scientist',
				role_description: 'Owns models',
				monthly_budget_cents: 7000,
				touches_code: true,
			},
			teamId,
			projectId,
		});
		expect(row).not.toBeNull();
		const content = (row as { content: Record<string, unknown> }).content;
		expect(content.kind).toBe(ActionCommentKind.HireProposal);
		expect(content.approval_id).toBe(approval.id);
		expect(content.title).toBe('Data Scientist');
		expect(content.monthly_budget_cents).toBe(7000);
		expect(content.touches_code).toBe(true);
	});

	it('defaults missing snapshot fields (budget, interval, role, touches_code)', async () => {
		const agent = await createAgent('Default Bot');
		const task = await createTask('Default Task', agent);
		const approval = await insertApproval({ task_id: task }, agent);

		const row = await insertHireProposalComment(db, {
			taskId: task,
			approvalId: approval.id as string,
			// Only title + slug — every other snapshot field falls back to its default.
			payload: { title: 'Bare Role', slug: 'bare-role' },
			teamId,
			projectId,
		});
		const content = (row as { content: Record<string, unknown> }).content;
		expect(content.role_description).toBe('');
		expect(content.monthly_budget_cents).toBe(0);
		expect(content.heartbeat_interval_min).toBeNull();
		expect(content.touches_code).toBe(false);
	});

	it('is idempotent per (task, approval): a second call returns null and does not duplicate', async () => {
		const agent = await createAgent('Idem Bot');
		const task = await createTask('Idem Task', agent);
		const approval = await insertApproval({ task_id: task }, agent);

		const first = await insertHireProposalComment(db, {
			taskId: task,
			approvalId: approval.id as string,
			payload: { title: 'Once', slug: 'once' },
			teamId,
			projectId,
		});
		expect(first).not.toBeNull();

		const second = await insertHireProposalComment(db, {
			taskId: task,
			approvalId: approval.id as string,
			payload: { title: 'Once', slug: 'once' },
			teamId,
			projectId,
		});
		expect(second).toBeNull();

		const count = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM task_comments
			 WHERE task_id = $1 AND content->>'approval_id' = $2`,
			[task, approval.id],
		);
		expect(count.rows[0].c).toBe(1);
	});
});

describe('resolveHireProposalCommentAndWake', () => {
	it('flips the comment to approved, refreshes the snapshot, and wakes the requesting agent', async () => {
		const requester = await createAgent('CEO-ish Bot');
		const task = await createTask('Resolve Task', requester);
		const approval = await insertApproval(
			{ task_id: task, title: 'Final Title', slug: 'final', monthly_budget_cents: 1200 },
			requester,
		);
		await insertHireProposalComment(db, {
			taskId: task,
			approvalId: approval.id as string,
			payload: { title: 'Draft Title', slug: 'final' },
			teamId,
			projectId,
		});

		await resolveHireProposalCommentAndWake(db, {
			approval,
			status: ApprovalStatus.Approved,
			memberAgentSlug: 'final',
			resolutionNote: 'looks good',
		});

		const row = await db.query<{
			content: Record<string, unknown>;
			chosen_option: Record<string, unknown>;
		}>(
			`SELECT content, chosen_option FROM task_comments
			 WHERE task_id = $1 AND content->>'approval_id' = $2`,
			[task, approval.id],
		);
		expect(row.rows[0].chosen_option.status).toBe(ApprovalStatus.Approved);
		expect(row.rows[0].chosen_option.member_agent_slug).toBe('final');
		expect(row.rows[0].chosen_option.resolution_note).toBe('looks good');
		// Snapshot refreshed from the (final) approved payload.
		expect(row.rows[0].content.title).toBe('Final Title');
		expect(row.rows[0].content.monthly_budget_cents).toBe(1200);

		// The requesting agent is queued to resume.
		const wake = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'approval_id' = $2`,
			[requester, approval.id],
		);
		expect(wake.rows[0].c).toBe(1);
	});

	it('returns early (no comment, no wake) when the approval has no originating task', async () => {
		const requester = await createAgent('No-Task Bot');
		const approval = await insertApproval({ title: 'No Task' }, requester);

		await resolveHireProposalCommentAndWake(db, {
			approval,
			status: ApprovalStatus.Denied,
		});

		const wake = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests
			 WHERE payload->>'approval_id' = $1`,
			[approval.id],
		);
		expect(wake.rows[0].c).toBe(0);
	});

	it('falls back to the ticket assignee agent when the requester is a human', async () => {
		const human = await createHumanMember();
		const assignee = await createAgent('Assignee Bot');
		const task = await createTask('Human-Requested Task', assignee);
		const approval = await insertApproval({ task_id: task, slug: 'denied-role' }, human);
		await insertHireProposalComment(db, {
			taskId: task,
			approvalId: approval.id as string,
			payload: { title: 'Denied', slug: 'denied-role' },
			teamId,
			projectId,
		});

		await resolveHireProposalCommentAndWake(db, {
			approval,
			status: ApprovalStatus.Denied,
		});

		// The human requester can't be re-woken — the assignee agent gets the wakeup.
		const wake = await db.query<{ member_id: string }>(
			`SELECT member_id FROM agent_wakeup_requests WHERE payload->>'approval_id' = $1`,
			[approval.id],
		);
		expect(wake.rows).toHaveLength(1);
		expect(wake.rows[0].member_id).toBe(assignee);
	});

	it('wakes nobody when neither requester nor assignee is an agent', async () => {
		const human = await createHumanMember();
		const assigneeHuman = await createHumanMember();
		// Create the task through the API (fills number/identifier), then reassign it
		// to a human member so neither requester nor assignee is an agent.
		const placeholder = await createAgent('Placeholder Bot');
		const task = await createTask('Human Assignee Task', placeholder);
		await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [assigneeHuman, task]);
		const approval = await insertApproval({ task_id: task }, human);

		await resolveHireProposalCommentAndWake(db, {
			approval,
			status: ApprovalStatus.Approved,
		});

		const wake = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests
			 WHERE payload->>'approval_id' = $1`,
			[approval.id],
		);
		expect(wake.rows[0].c).toBe(0);
	});

	it('does not update an already-resolved comment (chosen_option guard)', async () => {
		const requester = await createAgent('Twice Bot');
		const task = await createTask('Twice Task', requester);
		const approval = await insertApproval({ task_id: task, slug: 'twice' }, requester);
		await insertHireProposalComment(db, {
			taskId: task,
			approvalId: approval.id as string,
			payload: { title: 'Twice', slug: 'twice' },
			teamId,
			projectId,
		});

		await resolveHireProposalCommentAndWake(db, { approval, status: ApprovalStatus.Approved });
		// A second resolve with a different status must not overwrite the first.
		await resolveHireProposalCommentAndWake(db, { approval, status: ApprovalStatus.Denied });

		const row = await db.query<{ chosen_option: Record<string, unknown> }>(
			`SELECT chosen_option FROM task_comments
			 WHERE task_id = $1 AND content->>'approval_id' = $2`,
			[task, approval.id],
		);
		expect(row.rows[0].chosen_option.status).toBe(ApprovalStatus.Approved);
	});
});
