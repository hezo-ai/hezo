import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { enqueueRepoSetupResumeWakeups, ensureRepoSetupAction } from '../src/services/repo-setup';
import { safeClose } from './helpers';
import { createTestDbWithMigrations } from './helpers/db';

let db: Db;

async function seedTeamProjectTask(): Promise<{
	teamId: string;
	projectId: string;
	taskId: string;
}> {
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ('Ensure Co', 'ensure-co') RETURNING id`,
	);
	const teamId = team.rows[0].id;
	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix)
		 VALUES ($1, 'Ensure Project', 'ensure-project', 'E') RETURNING id`,
		[teamId],
	);
	const projectId = project.rows[0].id;
	const task = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title)
		 VALUES ($1, $2, 1, 'E-1', 'Needs repo') RETURNING id`,
		[teamId, projectId],
	);
	return { teamId, projectId, taskId: task.rows[0].id };
}

beforeEach(async () => {
	db = await createTestDbWithMigrations();
});

afterEach(async () => {
	await safeClose(db);
});

describe('ensureRepoSetupAction', () => {
	it('creates a pending designated-repo approval and a setup-repo action comment on first call', async () => {
		const { teamId, projectId, taskId } = await seedTeamProjectTask();

		const result = await ensureRepoSetupAction(db, { teamId, projectId, taskId });

		expect(result.approvalCreated).toBe(true);
		expect(result.commentCreated).toBe(true);
		expect(result.approvalId).toBeTruthy();
		expect(result.commentId).toBeTruthy();
		// Freshly-created rows are exposed for broadcast.
		expect(result.approvalRow?.id).toBe(result.approvalId);
		expect(result.commentRow?.id).toBe(result.commentId);

		const approval = await db.query<{
			type: string;
			status: string;
			payload: Record<string, string>;
		}>(`SELECT type::text AS type, status::text AS status, payload FROM approvals WHERE id = $1`, [
			result.approvalId,
		]);
		expect(approval.rows[0].type).toBe('designated_repo_request');
		expect(approval.rows[0].status).toBe('pending');
		expect(approval.rows[0].payload.project_id).toBe(projectId);
		expect(approval.rows[0].payload.task_id).toBe(taskId);

		const comment = await db.query<{ content_type: string; content: Record<string, string> }>(
			`SELECT content_type::text AS content_type, content FROM task_comments WHERE id = $1`,
			[result.commentId],
		);
		expect(comment.rows[0].content_type).toBe('action');
		expect(comment.rows[0].content.kind).toBe('setup_repo');
		expect(comment.rows[0].content.approval_id).toBe(result.approvalId);
	});

	it('is idempotent on the same task: reuses the approval + comment without creating duplicates', async () => {
		const { teamId, projectId, taskId } = await seedTeamProjectTask();

		const first = await ensureRepoSetupAction(db, { teamId, projectId, taskId });
		const second = await ensureRepoSetupAction(db, { teamId, projectId, taskId });

		expect(second.approvalId).toBe(first.approvalId);
		expect(second.commentId).toBe(first.commentId);
		expect(second.approvalCreated).toBe(false);
		expect(second.commentCreated).toBe(false);
		// No fresh rows surfaced when nothing was created.
		expect(second.approvalRow).toBeUndefined();
		expect(second.commentRow).toBeUndefined();

		const approvals = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM approvals WHERE team_id = $1`,
			[teamId],
		);
		expect(approvals.rows[0].c).toBe(1);
		const comments = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM task_comments WHERE task_id = $1`,
			[taskId],
		);
		expect(comments.rows[0].c).toBe(1);
	});

	it('reuses an existing pending approval but creates a fresh action comment on a second task', async () => {
		const { teamId, projectId, taskId } = await seedTeamProjectTask();
		const secondTask = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 2, 'E-2', 'Also needs repo') RETURNING id`,
			[teamId, projectId],
		);

		const first = await ensureRepoSetupAction(db, { teamId, projectId, taskId });
		const second = await ensureRepoSetupAction(db, {
			teamId,
			projectId,
			taskId: secondTask.rows[0].id,
		});

		// Same project-level approval is shared; a new action comment lands on task 2.
		expect(second.approvalId).toBe(first.approvalId);
		expect(second.approvalCreated).toBe(false);
		expect(second.commentCreated).toBe(true);
		expect(second.commentId).not.toBe(first.commentId);

		const approvals = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM approvals WHERE team_id = $1`,
			[teamId],
		);
		expect(approvals.rows[0].c).toBe(1);
	});
});

describe('enqueueRepoSetupResumeWakeups (edge cases)', () => {
	it('skips deferred wakeups that carry no task id', async () => {
		const { teamId } = await seedTeamProjectTask();
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Solo') RETURNING id`,
			[teamId],
		);

		await enqueueRepoSetupResumeWakeups(db, teamId, 'repo-1', 'approval-1', [
			{ memberId: member.rows[0].id, taskId: '', wakeupId: 'w-1' },
		]);

		const resumed = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM agent_wakeup_requests WHERE team_id = $1`,
			[teamId],
		);
		expect(resumed.rows[0].c).toBe(0);
	});
});
