import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TEAM_ID, TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { OAUTH_VERIFICATION_LABEL } from '../src/services/oauth-verification-tasks';
import { triggerStatusAutomations } from '../src/services/task-automation';
import { getWorktreesPath } from '../src/services/workspace';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

/**
 * Branch coverage for services/task-automation.ts that the existing
 * parent-cascade / oauth-verification suites don't reach:
 * - notifyParentOfOAuthVerification: labels-not-array, unknown platform marker
 *   (→ 'external' display), and a verification task whose parent IS labelled
 *   but the team HAS a Captain (so the comment is Captain-authored + wakeup).
 * - wakeParentIfChildrenClosed: parent assignee that is a human (not an agent).
 */

let db: Db;
let dataDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	dataDir = ctx.dataDir;
});

afterAll(async () => {
	await safeClose(db);
});

async function hqTask(opts: {
	title?: string;
	parentTaskId?: string | null;
	labels?: string[];
	description?: string;
	assigneeId?: string | null;
	status?: string;
}): Promise<string> {
	const meta = await db.query<{ task_prefix: string; number: number; project_id: string }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number, p.id AS project_id
		 FROM projects p WHERE p.team_id = $1 AND p.is_internal = true`,
		[DEFAULT_TEAM_ID],
	);
	const row = meta.rows[0];
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title, description, status, parent_task_id, assignee_id, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::task_status, $8, $9, $10::jsonb)
		 RETURNING id`,
		[
			DEFAULT_TEAM_ID,
			row.project_id,
			row.number,
			`${row.task_prefix}-${row.number}`,
			opts.title ?? 'task',
			opts.description ?? '',
			opts.status ?? TaskStatus.Backlog,
			opts.parentTaskId ?? null,
			opts.assigneeId ?? null,
			JSON.stringify(opts.labels ?? []),
		],
	);
	return inserted.rows[0].id;
}

describe('notifyParentOfOAuthVerification — label and platform branches', () => {
	it('skips when the parent task is not labelled as an OAuth verification', async () => {
		const parent = await hqTask({ title: 'parent unlabelled' });
		// A done sub-task that carries no OAUTH_VERIFICATION_LABEL → labels.includes(...) false.
		const child = await hqTask({
			title: 'child not a verification',
			parentTaskId: parent,
			description: 'oauth-verify platform=github',
			labels: [],
			status: TaskStatus.Done,
		});

		const before = await commentCount(parent);
		await triggerStatusAutomations(
			db,
			DEFAULT_TEAM_ID,
			child,
			TaskStatus.Backlog,
			TaskStatus.Done,
			null,
			null,
		);
		// No confirmation comment posted on the parent.
		expect(await verifiedCommentCount(parent)).toBe(0);
		// (status_change is posted on the CHILD, not the parent.)
		expect(await commentCount(parent)).toBe(before);
	});

	it('falls back to the "external" display name when no platform marker is present', async () => {
		const parent = await hqTask({ title: 'parent external' });
		const child = await hqTask({
			title: 'verification no marker',
			parentTaskId: parent,
			description: 'no platform marker here',
			labels: [OAUTH_VERIFICATION_LABEL],
			status: TaskStatus.Done,
		});

		await triggerStatusAutomations(
			db,
			DEFAULT_TEAM_ID,
			child,
			TaskStatus.Backlog,
			TaskStatus.Done,
			null,
			null,
		);

		const text = await latestVerifiedText(parent);
		expect(text).toContain('external');
	});

	it('uses a known platform display name (Stripe) when the marker matches', async () => {
		const parent = await hqTask({ title: 'parent stripe' });
		const child = await hqTask({
			title: 'verification stripe',
			parentTaskId: parent,
			description: 'oauth-verify platform=stripe',
			labels: [OAUTH_VERIFICATION_LABEL],
			status: TaskStatus.Done,
		});

		await triggerStatusAutomations(
			db,
			DEFAULT_TEAM_ID,
			child,
			TaskStatus.Backlog,
			TaskStatus.Done,
			null,
			null,
		);

		const text = await latestVerifiedText(parent);
		expect(text).toContain('Stripe');
	});
});

describe('notifyParentOfOAuthVerification — Captain-authored comment + wakeup', () => {
	it('authors the confirmation as the team Captain and queues a wakeup when one exists', async () => {
		// A real project team (App Team template) so a Captain exists in the team.
		const ctx2 = await createTestApp();
		const db2 = ctx2.db;
		try {
			const typesRes = await ctx2.app.request('/api/team-templates', {
				headers: authHeader(ctx2.token),
			});
			const typeId = (await typesRes.json()).data.find(
				(t: { name: string }) => t.name === 'App Team',
			).id;
			const teamRes = await createTestTeam(db2, { name: 'Verif Cap Co', template_id: typeId });
			const teamId = (await teamRes.json()).data.id;
			await projectSlugFor(db2, teamId);
			const projectRes = await createTestProject(db2, teamId, { name: 'Verif Project' });
			const proj = (await projectRes.json()).data;

			const captain = await db2.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
				[teamId],
			);
			const captainId = captain.rows[0].id;

			const mk = async (opts: {
				parentTaskId?: string | null;
				labels?: string[];
				description?: string;
			}): Promise<string> => {
				const meta = await db2.query<{ task_prefix: string; number: number }>(
					`SELECT task_prefix, next_project_task_number(id) AS number FROM projects WHERE id = $1`,
					[proj.id],
				);
				const r = meta.rows[0];
				const t = await db2.query<{ id: string }>(
					`INSERT INTO tasks (team_id, project_id, number, identifier, title, description, status, parent_task_id, labels)
					 VALUES ($1, $2, $3, $4, 'vt', $5, 'done'::task_status, $6, $7::jsonb)
					 RETURNING id`,
					[
						teamId,
						proj.id,
						r.number,
						`${r.task_prefix}-${r.number}`,
						opts.description ?? '',
						opts.parentTaskId ?? null,
						JSON.stringify(opts.labels ?? []),
					],
				);
				return t.rows[0].id;
			};

			const parent = await mk({});
			const child = await mk({
				parentTaskId: parent,
				description: 'oauth-verify platform=github',
				labels: [OAUTH_VERIFICATION_LABEL],
			});

			await db2.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [captainId]);
			await triggerStatusAutomations(
				db2,
				teamId,
				child,
				TaskStatus.Backlog,
				TaskStatus.Done,
				null,
				null,
			);

			const comment = await db2.query<{ author_member_id: string | null }>(
				`SELECT author_member_id FROM task_comments
				 WHERE task_id = $1 AND content_type = 'text' AND content->>'text' ILIKE '%verified%'`,
				[parent],
			);
			expect(comment.rows[0]?.author_member_id).toBe(captainId);

			const wakeups = await db2.query<{ id: string }>(
				`SELECT id FROM agent_wakeup_requests
				 WHERE member_id = $1 AND payload->>'trigger' = 'oauth_verified'`,
				[captainId],
			);
			expect(wakeups.rows.length).toBeGreaterThan(0);
		} finally {
			await safeClose(db2);
		}
	});
});

describe('wakeParentIfChildrenClosed — parent assignee is not an agent', () => {
	it('does not wake when the parent is assigned to a human member', async () => {
		// A human member in HQ to assign the parent to.
		const user = await db.query<{ id: string }>(
			`INSERT INTO users (display_name) VALUES ('Human Owner') RETURNING id`,
		);
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type) VALUES ($1, 'user'::member_type) RETURNING id`,
			[DEFAULT_TEAM_ID],
		);
		await db.query(`INSERT INTO member_users (id, user_id) VALUES ($1, $2)`, [
			member.rows[0].id,
			user.rows[0].id,
		]);

		const parent = await hqTask({ title: 'human parent', assigneeId: member.rows[0].id });
		const child = await hqTask({
			title: 'child of human',
			parentTaskId: parent,
			status: TaskStatus.Done,
		});

		await triggerStatusAutomations(
			db,
			DEFAULT_TEAM_ID,
			child,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			null,
		);

		// No assignment wakeup landed for the human member.
		const wakeups = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests WHERE member_id = $1`,
			[member.rows[0].id],
		);
		expect(wakeups.rows.length).toBe(0);
	});
});

describe('triggerStatusAutomations — worktree cleanup on close', () => {
	// Seeds a fake per-task worktree dir at the real on-disk layout the runner uses:
	// <worktreesRoot>/<identifier>/<repo>. Returns the task's identifier-scoped dir.
	async function seedWorktreeDir(taskId: string): Promise<string> {
		const meta = await db.query<{ identifier: string; project_id: string }>(
			'SELECT identifier, project_id FROM tasks WHERE id = $1',
			[taskId],
		);
		const { identifier, project_id } = meta.rows[0];
		const taskDir = join(getWorktreesPath(dataDir, DEFAULT_TEAM_ID, project_id), identifier);
		mkdirSync(join(taskDir, 'repo'), { recursive: true });
		writeFileSync(join(taskDir, 'repo', 'file.txt'), 'work');
		return taskDir;
	}

	it('removes the task worktree when the task reaches Done (the MCP + REST shared path)', async () => {
		const task = await hqTask({ title: 'done with worktree', status: TaskStatus.InProgress });
		const taskDir = await seedWorktreeDir(task);
		expect(existsSync(taskDir)).toBe(true);

		await triggerStatusAutomations(
			db,
			DEFAULT_TEAM_ID,
			task,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			null,
			undefined,
			dataDir,
		);

		expect(existsSync(taskDir)).toBe(false);
	});

	it('removes the task worktree when the task is Cancelled', async () => {
		const task = await hqTask({ title: 'cancelled with worktree', status: TaskStatus.InProgress });
		const taskDir = await seedWorktreeDir(task);

		await triggerStatusAutomations(
			db,
			DEFAULT_TEAM_ID,
			task,
			TaskStatus.InProgress,
			TaskStatus.Cancelled,
			null,
			null,
			undefined,
			dataDir,
		);

		expect(existsSync(taskDir)).toBe(false);
	});

	it('leaves the worktree intact on a non-terminal transition (run start)', async () => {
		const task = await hqTask({ title: 'starting run', status: TaskStatus.Backlog });
		const taskDir = await seedWorktreeDir(task);

		await triggerStatusAutomations(
			db,
			DEFAULT_TEAM_ID,
			task,
			TaskStatus.Backlog,
			TaskStatus.InProgress,
			null,
			null,
			undefined,
			dataDir,
		);

		expect(existsSync(taskDir)).toBe(true);
	});

	it('is a no-op for worktrees when no dataDir is threaded through', async () => {
		const task = await hqTask({ title: 'no dataDir', status: TaskStatus.InProgress });
		const taskDir = await seedWorktreeDir(task);

		await triggerStatusAutomations(
			db,
			DEFAULT_TEAM_ID,
			task,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			null,
			undefined,
			undefined,
		);

		expect(existsSync(taskDir)).toBe(true);
	});
});

async function commentCount(taskId: string): Promise<number> {
	const r = await db.query<{ c: number }>(
		`SELECT count(*)::int AS c FROM task_comments WHERE task_id = $1`,
		[taskId],
	);
	return r.rows[0].c;
}

async function verifiedCommentCount(taskId: string): Promise<number> {
	const r = await db.query<{ c: number }>(
		`SELECT count(*)::int AS c FROM task_comments
		 WHERE task_id = $1 AND content_type = 'text' AND content->>'text' ILIKE '%verified%'`,
		[taskId],
	);
	return r.rows[0].c;
}

async function latestVerifiedText(taskId: string): Promise<string> {
	const r = await db.query<{ content: { text?: string } }>(
		`SELECT content FROM task_comments
		 WHERE task_id = $1 AND content_type = 'text' AND content->>'text' ILIKE '%verified%'
		 ORDER BY created_at DESC LIMIT 1`,
		[taskId],
	);
	return r.rows[0]?.content.text ?? '';
}
