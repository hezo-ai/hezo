import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { enqueueRepoSetupResumeWakeups, finalizePendingRepoSetup } from '../../services/repo-setup';
import { safeClose } from '../helpers';
import { createTestDbWithMigrations } from '../helpers/db';

async function seedCompanyProject(db: PGlite): Promise<{ companyId: string; projectId: string }> {
	const company = await db.query<{ id: string }>(
		`INSERT INTO companies (name, slug) VALUES ('Multi Co', 'multi-co') RETURNING id`,
	);
	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (company_id, name, slug, issue_prefix)
		 VALUES ($1, 'Multi Project', 'multi-project', 'M') RETURNING id`,
		[company.rows[0].id],
	);
	return { companyId: company.rows[0].id, projectId: project.rows[0].id };
}

async function seedAgent(db: PGlite, companyId: string, title: string): Promise<string> {
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (company_id, member_type, display_name)
		 VALUES ($1, 'agent', $2) RETURNING id`,
		[companyId, title],
	);
	await db.query(
		`INSERT INTO member_agents (id, title, slug, role_description, default_effort,
		                            heartbeat_interval_min, monthly_budget_cents, touches_code, admin_status)
		 VALUES ($1, $2, $3, '', 'medium', 60, 3000, true, 'enabled')`,
		[member.rows[0].id, title, title.toLowerCase().replace(/\s+/g, '-')],
	);
	return member.rows[0].id;
}

async function seedIssue(
	db: PGlite,
	companyId: string,
	projectId: string,
	number: number,
	title: string,
	assigneeId: string,
): Promise<string> {
	const issue = await db.query<{ id: string }>(
		`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier, title)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[companyId, projectId, assigneeId, number, `M-${number}`, title],
	);
	return issue.rows[0].id;
}

async function seedApprovalAndComments(
	db: PGlite,
	companyId: string,
	projectId: string,
	issueIds: string[],
): Promise<{ approvalId: string; commentIds: string[] }> {
	const approval = await db.query<{ id: string }>(
		`INSERT INTO approvals (company_id, type, status, payload)
		 VALUES ($1, 'designated_repo_request'::approval_type, 'pending'::approval_status, $2::jsonb)
		 RETURNING id`,
		[
			companyId,
			JSON.stringify({
				platform: 'github',
				reason: 'designated_repo',
				project_id: projectId,
				issue_id: issueIds[0],
			}),
		],
	);
	const commentIds: string[] = [];
	for (const issueId of issueIds) {
		const r = await db.query<{ id: string }>(
			`INSERT INTO issue_comments (issue_id, content_type, content)
			 VALUES ($1, 'action'::comment_content_type, $2::jsonb) RETURNING id`,
			[issueId, JSON.stringify({ kind: 'setup_repo', approval_id: approval.rows[0].id })],
		);
		commentIds.push(r.rows[0].id);
	}
	return { approvalId: approval.rows[0].id, commentIds };
}

async function seedDeferredWakeup(
	db: PGlite,
	companyId: string,
	memberId: string,
	projectId: string,
	issueId: string,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, payload)
		 VALUES ($1, $2, 'automation'::wakeup_source, 'deferred'::wakeup_status, $3::jsonb)
		 RETURNING id`,
		[
			memberId,
			companyId,
			JSON.stringify({ reason: 'awaiting_repo_setup', project_id: projectId, issue_id: issueId }),
		],
	);
	return r.rows[0].id;
}

describe('finalizePendingRepoSetup + enqueueRepoSetupResumeWakeups (multi-agent)', () => {
	it('resolves all blocked comments, queues a resume wakeup per agent, exposes rows for broadcast', async () => {
		const db = await createTestDbWithMigrations();
		try {
			const { companyId, projectId } = await seedCompanyProject(db);

			const aliceId = await seedAgent(db, companyId, 'Alice');
			const bobId = await seedAgent(db, companyId, 'Bob');
			const carolId = await seedAgent(db, companyId, 'Carol');

			const issueA = await seedIssue(db, companyId, projectId, 1, 'Alice work', aliceId);
			const issueB = await seedIssue(db, companyId, projectId, 2, 'Bob work', bobId);
			const issueC = await seedIssue(db, companyId, projectId, 3, 'Carol work', carolId);

			const { approvalId, commentIds } = await seedApprovalAndComments(db, companyId, projectId, [
				issueA,
				issueB,
				issueC,
			]);

			await seedDeferredWakeup(db, companyId, aliceId, projectId, issueA);
			await seedDeferredWakeup(db, companyId, bobId, projectId, issueB);
			await seedDeferredWakeup(db, companyId, carolId, projectId, issueC);

			const repoInsert = await db.query<{ id: string }>(
				`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
				 VALUES ($1, 'main', 'octo/multi', 'github') RETURNING id`,
				[projectId],
			);

			const result = await finalizePendingRepoSetup(db, {
				companyId,
				projectId,
				repoId: repoInsert.rows[0].id,
				repoIdentifier: 'octo/multi',
				shortName: 'main',
			});

			expect(result.resolvedApprovalId).toBe(approvalId);
			expect(result.affectedIssueIds.sort()).toEqual([issueA, issueB, issueC].sort());
			expect(result.deferredWakeups).toHaveLength(3);
			expect(result.approvalRow?.id).toBe(approvalId);
			expect(result.approvalRow?.status).toBe('approved');
			expect(result.updatedCommentRows).toHaveLength(3);
			expect(result.systemCommentRows).toHaveLength(3);

			for (const cId of commentIds) {
				const cRow = await db.query<{ chosen_option: { status?: string } }>(
					`SELECT chosen_option FROM issue_comments WHERE id = $1`,
					[cId],
				);
				expect(cRow.rows[0].chosen_option?.status).toBe('complete');
			}

			for (const issueId of [issueA, issueB, issueC]) {
				const sys = await db.query<{ id: string }>(
					`SELECT id FROM issue_comments WHERE issue_id = $1 AND content_type = 'system'::comment_content_type`,
					[issueId],
				);
				expect(sys.rows).toHaveLength(1);
			}

			await enqueueRepoSetupResumeWakeups(
				db,
				companyId,
				repoInsert.rows[0].id,
				approvalId,
				result.deferredWakeups,
			);

			const resumed = await db.query<{ member_id: string; payload: Record<string, unknown> }>(
				`SELECT member_id, payload FROM agent_wakeup_requests
				 WHERE company_id = $1 AND status = 'queued'::wakeup_status
				   AND source = 'automation'::wakeup_source
				   AND payload->>'reason' = 'repo_setup_complete'`,
				[companyId],
			);
			expect(resumed.rows).toHaveLength(3);
			const memberIds = resumed.rows.map((r) => r.member_id).sort();
			expect(memberIds).toEqual([aliceId, bobId, carolId].sort());

			const oldDeferred = await db.query<{ count: number }>(
				`SELECT COUNT(*)::int AS count FROM agent_wakeup_requests
				 WHERE company_id = $1 AND status = 'deferred'::wakeup_status`,
				[companyId],
			);
			expect(oldDeferred.rows[0].count).toBe(3);
		} finally {
			await safeClose(db);
		}
	});

	it('is a no-op when no pending approval exists for the project', async () => {
		const db = await createTestDbWithMigrations();
		try {
			const { companyId, projectId } = await seedCompanyProject(db);

			const result = await finalizePendingRepoSetup(db, {
				companyId,
				projectId,
				repoId: '00000000-0000-0000-0000-000000000000',
				repoIdentifier: 'octo/none',
				shortName: 'main',
			});

			expect(result.resolvedApprovalId).toBeNull();
			expect(result.affectedIssueIds).toEqual([]);
			expect(result.deferredWakeups).toEqual([]);
			expect(result.approvalRow).toBeNull();
			expect(result.updatedCommentRows).toEqual([]);
			expect(result.systemCommentRows).toEqual([]);
		} finally {
			await safeClose(db);
		}
	});
});
