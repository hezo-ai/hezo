import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, TaskStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { OAUTH_VERIFICATION_LABEL } from '../src/services/oauth-verification-tasks';
import { triggerStatusAutomations } from '../src/services/task-automation';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCoachId,
	projectSlugFor,
} from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let captainId: string;
let engineerId: string;
let coachId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;
	coachId = await instanceCoachId(db);

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, {
		name: 'Automation Cov Co',
		template_id: teamTemplateId,
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	const internalProjectSlug = await projectSlugFor(db, teamId);

	const projectRes = await createTestProject(db, teamId, {
		name: 'Automation Cov Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${internalProjectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	captainId = agents.find((a) => a.slug === 'captain')!.id;
	engineerId = agents.find((a) => a.slug === 'engineer')!.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTask(
	title: string,
	assigneeId: string | null,
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title,
			...(assigneeId ? { assignee_id: assigneeId } : {}),
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function setStatusDirect(taskId: string, status: string): Promise<void> {
	await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [status, taskId]);
}

describe('triggerStatusAutomations — Coach wakeup on Done', () => {
	it('queues an Automation wakeup for the global Coach when a task moves to done', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [coachId]);
		const task = await createTask('coach target', engineerId);

		await setStatusDirect(task.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			task.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			null,
		);

		const wakeups = await db.query<{ payload: Record<string, unknown>; source: string }>(
			`SELECT payload, source::text AS source FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = $2
			 ORDER BY created_at DESC LIMIT 1`,
			[coachId, WakeupSource.Automation],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
		expect(wakeups.rows[0].payload.trigger).toBe('task_done');
		expect(wakeups.rows[0].payload.task_id).toBe(task.id);
		// The wakeup carries the completed task's team so the Coach runs scoped there.
		const teamScoped = await db.query<{ team_id: string }>(
			`SELECT team_id FROM agent_wakeup_requests WHERE member_id = $1 AND source = $2 ORDER BY created_at DESC LIMIT 1`,
			[coachId, WakeupSource.Automation],
		);
		expect(teamScoped.rows[0].team_id).toBe(teamId);
	});

	it('does not wake the Coach when a task moves to cancelled (terminal but not done)', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [coachId]);
		const task = await createTask('coach skip', engineerId);

		await setStatusDirect(task.id, TaskStatus.Cancelled);
		await triggerStatusAutomations(
			db,
			teamId,
			task.id,
			TaskStatus.InProgress,
			TaskStatus.Cancelled,
			null,
			null,
		);

		const wakeups = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = $2 AND payload->>'task_id' = $3`,
			[coachId, WakeupSource.Automation, task.id],
		);
		expect(wakeups.rows[0].n).toBe(0);
	});
});

describe('triggerStatusAutomations — downstream-readiness recompute boundary', () => {
	it('recomputes downstream readiness only on a terminal-boundary crossing', async () => {
		// blocker → dependent. The dependent is held in `blocked` (its derived
		// gate state). reconcileBlockedStatus flips it to `backlog` only once the
		// blocker reaches a terminal status, and only when the recompute runs.
		const blocker = await createTask('boundary blocker', engineerId);
		const dependent = await createTask('boundary dependent', engineerId);
		await db.query(`INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)`, [
			dependent.id,
			blocker.id,
		]);
		await setStatusDirect(dependent.id, TaskStatus.Blocked);

		// Non-crossing transition (backlog → in_progress): both non-terminal, so
		// the recompute is skipped and the dependent stays blocked.
		await setStatusDirect(blocker.id, TaskStatus.InProgress);
		await triggerStatusAutomations(
			db,
			teamId,
			blocker.id,
			TaskStatus.Backlog,
			TaskStatus.InProgress,
			null,
			null,
		);
		let dep = await db.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [
			dependent.id,
		]);
		expect(dep.rows[0].status).toBe(TaskStatus.Blocked);

		// Crossing transition (in_progress → done): recompute fires, dependent unblocks.
		await setStatusDirect(blocker.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			blocker.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			null,
		);
		dep = await db.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [
			dependent.id,
		]);
		expect(dep.rows[0].status).toBe(TaskStatus.Backlog);
	});
});

describe('notifyParentOfOAuthVerification — Captain-found branch', () => {
	it('posts a Captain-authored confirmation on the parent and wakes the Captain', async () => {
		// A parent ticket on a project team that has an enabled Captain. The
		// verification sub-task carries the oauth-verification label + marker.
		const parent = await createTask('oauth originating', captainId);

		// Build the verification sub-task by hand: parent_task_id + label + marker.
		const meta = await db.query<{ number: number; task_prefix: string }>(
			`SELECT next_project_task_number(p.id) AS number, p.task_prefix
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const num = meta.rows[0].number;
		const verifRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, parent_task_id, number, identifier, title, description, status, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::jsonb)
			 RETURNING id`,
			[
				teamId,
				projectId,
				parent.id,
				num,
				`${meta.rows[0].task_prefix}-${num}`,
				'Verify GitHub connector',
				'<!-- oauth-verify platform=github -->\n\nbody',
				TaskStatus.Backlog,
				JSON.stringify(['internal', OAUTH_VERIFICATION_LABEL]),
			],
		);
		const verifId = verifRes.rows[0].id;

		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [captainId]);

		await setStatusDirect(verifId, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			verifId,
			TaskStatus.Backlog,
			TaskStatus.Done,
			null,
			null,
		);

		const comments = await db.query<{
			content: { text?: string };
			author_member_id: string | null;
		}>(
			`SELECT content, author_member_id FROM task_comments
			 WHERE task_id = $1 AND content_type = $2`,
			[parent.id, CommentContentType.Text],
		);
		const confirmation = comments.rows.find((c) =>
			c.content.text?.toLowerCase().includes('verified'),
		);
		expect(confirmation).toBeTruthy();
		// Authored by the team's Captain (resolved by slug + enabled admin status).
		expect(confirmation?.author_member_id).toBe(captainId);
		expect(confirmation?.content.text).toContain('GitHub');

		// The Captain is woken with the oauth_verified trigger on the parent.
		const wakeups = await db.query<{ payload: Record<string, unknown> }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'trigger' = 'oauth_verified'`,
			[captainId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
		expect(wakeups.rows[0].payload.task_id).toBe(parent.id);
	});

	it('skips the confirmation when the parent task lacks the oauth-verification label', async () => {
		const parent = await createTask('non-oauth parent', captainId);
		const meta = await db.query<{ number: number; task_prefix: string }>(
			`SELECT next_project_task_number(p.id) AS number, p.task_prefix
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const num = meta.rows[0].number;
		const childRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, parent_task_id, number, identifier, title, description, status, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::jsonb)
			 RETURNING id`,
			[
				teamId,
				projectId,
				parent.id,
				num,
				`${meta.rows[0].task_prefix}-${num}`,
				'Ordinary child',
				'no marker here',
				TaskStatus.Backlog,
				JSON.stringify(['internal']),
			],
		);
		const childId = childRes.rows[0].id;

		const before = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM task_comments WHERE task_id = $1 AND content_type = $2`,
			[parent.id, CommentContentType.Text],
		);

		await setStatusDirect(childId, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			childId,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			null,
		);

		const after = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM task_comments WHERE task_id = $1 AND content_type = $2`,
			[parent.id, CommentContentType.Text],
		);
		// No confirmation text comment added (label guard returns early).
		expect(after.rows[0].n).toBe(before.rows[0].n);
	});
});
