import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { enqueueRepoSetupResumeWakeups, finalizePendingRepoSetup } from '../../services/repo-setup';
import { safeClose } from '../helpers';
import { createTestDbWithMigrations } from '../helpers/db';

async function seedTeamProject(db: PGlite): Promise<{ teamId: string; projectId: string }> {
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ('Multi Co', 'multi-co') RETURNING id`,
	);
	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix)
		 VALUES ($1, 'Multi Project', 'multi-project', 'M') RETURNING id`,
		[team.rows[0].id],
	);
	return { teamId: team.rows[0].id, projectId: project.rows[0].id };
}

async function seedAgent(db: PGlite, teamId: string, title: string): Promise<string> {
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'agent', $2) RETURNING id`,
		[teamId, title],
	);
	await db.query(
		`INSERT INTO member_agents (id, title, slug, role_description, default_effort,
		                            heartbeat_interval_min, monthly_budget_cents, touches_code, admin_status)
		 VALUES ($1, $2, $3, '', 'medium', 60, 3000, true, 'enabled')`,
		[member.rows[0].id, title, title.toLowerCase().replace(/\s+/g, '-')],
	);
	return member.rows[0].id;
}

async function seedTask(
	db: PGlite,
	teamId: string,
	projectId: string,
	number: number,
	title: string,
	assigneeId: string,
): Promise<string> {
	const task = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[teamId, projectId, assigneeId, number, `M-${number}`, title],
	);
	return task.rows[0].id;
}

async function seedApprovalAndComments(
	db: PGlite,
	teamId: string,
	projectId: string,
	taskIds: string[],
): Promise<{ approvalId: string; commentIds: string[] }> {
	const approval = await db.query<{ id: string }>(
		`INSERT INTO approvals (team_id, type, status, payload)
		 VALUES ($1, 'designated_repo_request'::approval_type, 'pending'::approval_status, $2::jsonb)
		 RETURNING id`,
		[
			teamId,
			JSON.stringify({
				platform: 'github',
				reason: 'designated_repo',
				project_id: projectId,
				task_id: taskIds[0],
			}),
		],
	);
	const commentIds: string[] = [];
	for (const taskId of taskIds) {
		const r = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'action'::comment_content_type, $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ kind: 'setup_repo', approval_id: approval.rows[0].id })],
		);
		commentIds.push(r.rows[0].id);
	}
	return { approvalId: approval.rows[0].id, commentIds };
}

async function seedDeferredWakeup(
	db: PGlite,
	teamId: string,
	memberId: string,
	projectId: string,
	taskId: string,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
		 VALUES ($1, $2, 'automation'::wakeup_source, 'deferred'::wakeup_status, $3::jsonb)
		 RETURNING id`,
		[
			memberId,
			teamId,
			JSON.stringify({ reason: 'awaiting_repo_setup', project_id: projectId, task_id: taskId }),
		],
	);
	return r.rows[0].id;
}

describe('finalizePendingRepoSetup + enqueueRepoSetupResumeWakeups (multi-agent)', () => {
	it('resolves all blocked comments, queues a resume wakeup per agent, exposes rows for broadcast', async () => {
		const db = await createTestDbWithMigrations();
		try {
			const { teamId, projectId } = await seedTeamProject(db);

			const aliceId = await seedAgent(db, teamId, 'Alice');
			const bobId = await seedAgent(db, teamId, 'Bob');
			const carolId = await seedAgent(db, teamId, 'Carol');

			const taskA = await seedTask(db, teamId, projectId, 1, 'Alice work', aliceId);
			const taskB = await seedTask(db, teamId, projectId, 2, 'Bob work', bobId);
			const taskC = await seedTask(db, teamId, projectId, 3, 'Carol work', carolId);

			const { approvalId, commentIds } = await seedApprovalAndComments(db, teamId, projectId, [
				taskA,
				taskB,
				taskC,
			]);

			await seedDeferredWakeup(db, teamId, aliceId, projectId, taskA);
			await seedDeferredWakeup(db, teamId, bobId, projectId, taskB);
			await seedDeferredWakeup(db, teamId, carolId, projectId, taskC);

			const repoInsert = await db.query<{ id: string }>(
				`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
				 VALUES ($1, 'main', 'octo/multi', 'github') RETURNING id`,
				[projectId],
			);

			const result = await finalizePendingRepoSetup(db, {
				teamId,
				projectId,
				repoId: repoInsert.rows[0].id,
				repoIdentifier: 'octo/multi',
				shortName: 'main',
			});

			expect(result.resolvedApprovalId).toBe(approvalId);
			expect(result.affectedTaskIds.sort()).toEqual([taskA, taskB, taskC].sort());
			expect(result.deferredWakeups).toHaveLength(3);
			expect(result.approvalRow?.id).toBe(approvalId);
			expect(result.approvalRow?.status).toBe('approved');
			expect(result.updatedCommentRows).toHaveLength(3);
			expect(result.systemCommentRows).toHaveLength(3);

			for (const cId of commentIds) {
				const cRow = await db.query<{ chosen_option: { status?: string } }>(
					`SELECT chosen_option FROM task_comments WHERE id = $1`,
					[cId],
				);
				expect(cRow.rows[0].chosen_option?.status).toBe('complete');
			}

			for (const taskId of [taskA, taskB, taskC]) {
				const sys = await db.query<{ id: string }>(
					`SELECT id FROM task_comments WHERE task_id = $1 AND content_type = 'system'::comment_content_type`,
					[taskId],
				);
				expect(sys.rows).toHaveLength(1);
			}

			await enqueueRepoSetupResumeWakeups(
				db,
				teamId,
				repoInsert.rows[0].id,
				approvalId,
				result.deferredWakeups,
			);

			const resumed = await db.query<{ member_id: string; payload: Record<string, unknown> }>(
				`SELECT member_id, payload FROM agent_wakeup_requests
				 WHERE team_id = $1 AND status = 'queued'::wakeup_status
				   AND source = 'automation'::wakeup_source
				   AND payload->>'reason' = 'repo_setup_complete'`,
				[teamId],
			);
			expect(resumed.rows).toHaveLength(3);
			const memberIds = resumed.rows.map((r) => r.member_id).sort();
			expect(memberIds).toEqual([aliceId, bobId, carolId].sort());

			const oldDeferred = await db.query<{ count: number }>(
				`SELECT COUNT(*)::int AS count FROM agent_wakeup_requests
				 WHERE team_id = $1 AND status = 'deferred'::wakeup_status`,
				[teamId],
			);
			expect(oldDeferred.rows[0].count).toBe(3);
		} finally {
			await safeClose(db);
		}
	});

	it('is a no-op when no pending approval exists for the project', async () => {
		const db = await createTestDbWithMigrations();
		try {
			const { teamId, projectId } = await seedTeamProject(db);

			const result = await finalizePendingRepoSetup(db, {
				teamId,
				projectId,
				repoId: '00000000-0000-0000-0000-000000000000',
				repoIdentifier: 'octo/none',
				shortName: 'main',
			});

			expect(result.resolvedApprovalId).toBeNull();
			expect(result.affectedTaskIds).toEqual([]);
			expect(result.deferredWakeups).toEqual([]);
			expect(result.approvalRow).toBeNull();
			expect(result.updatedCommentRows).toEqual([]);
			expect(result.systemCommentRows).toEqual([]);
		} finally {
			await safeClose(db);
		}
	});
});
