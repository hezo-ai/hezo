import type { PGlite } from '@electric-sql/pglite';
import { IssueStatus, PlatformType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { triggerStatusAutomations } from '../../services/issue-automation';
import { enqueueOAuthVerificationTask } from '../../services/oauth-verification-tasks';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let ceoMemberId: string;
let parentProjectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'OAuth Auto Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	const ceo = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = 'ceo'`,
		[companyId],
	);
	ceoMemberId = ceo.rows[0].id;

	const ops = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE company_id = $1 AND slug = 'operations'`,
		[companyId],
	);
	parentProjectId = ops.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createParentIssue(title = 'Originating ticket'): Promise<string> {
	const meta = await db.query<{ issue_prefix: string; number: number }>(
		`SELECT p.issue_prefix, next_project_issue_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[parentProjectId],
	);
	const row = meta.rows[0];
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO issues (company_id, project_id, number, identifier, title)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[companyId, parentProjectId, row.number, `${row.issue_prefix}-${row.number}`, title],
	);
	return inserted.rows[0].id;
}

describe('triggerStatusAutomations: OAuth verification done', () => {
	it('posts a CEO-authored comment on the parent when the verification issue moves to done', async () => {
		const parentId = await createParentIssue();
		const verif = await enqueueOAuthVerificationTask(
			db,
			companyId,
			PlatformType.GitHub,
			parentId,
			{},
		);
		expect(verif?.issueId).toBeTruthy();

		await db.query('UPDATE issues SET status = $1::issue_status WHERE id = $2', [
			IssueStatus.Done,
			verif!.issueId,
		]);
		await triggerStatusAutomations(
			db,
			companyId,
			verif!.issueId,
			IssueStatus.Backlog,
			IssueStatus.Done,
			null,
			undefined,
		);

		const comments = await db.query<{
			content: { text?: string };
			author_member_id: string | null;
			content_type: string;
		}>('SELECT content, author_member_id, content_type FROM issue_comments WHERE issue_id = $1', [
			parentId,
		]);
		const ceoComment = comments.rows.find((c) => c.author_member_id === ceoMemberId);
		expect(ceoComment).toBeTruthy();
		expect(ceoComment?.content_type).toBe('text');
		expect(ceoComment?.content.text).toContain('GitHub');
		expect(ceoComment?.content.text?.toLowerCase()).toContain('verified');
	});

	it('does nothing when the done issue has no parent_issue_id', async () => {
		const verif = await enqueueOAuthVerificationTask(db, companyId, PlatformType.Stripe, null, {});
		const commentsBefore = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM issue_comments
			 WHERE author_member_id = $1`,
			[ceoMemberId],
		);

		await db.query('UPDATE issues SET status = $1::issue_status WHERE id = $2', [
			IssueStatus.Done,
			verif!.issueId,
		]);
		await triggerStatusAutomations(
			db,
			companyId,
			verif!.issueId,
			IssueStatus.Backlog,
			IssueStatus.Done,
			null,
			undefined,
		);

		const commentsAfter = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM issue_comments
			 WHERE author_member_id = $1`,
			[ceoMemberId],
		);
		expect(commentsAfter.rows[0].count).toBe(commentsBefore.rows[0].count);
	});

	it('does nothing when a non-verification issue moves to done (beyond the Coach wake-up)', async () => {
		const parentId = await createParentIssue('Plain issue');
		const before = await db.query<{ count: string }>(
			'SELECT count(*)::text AS count FROM issue_comments WHERE issue_id = $1',
			[parentId],
		);

		await db.query('UPDATE issues SET status = $1::issue_status WHERE id = $2', [
			IssueStatus.Done,
			parentId,
		]);
		await triggerStatusAutomations(
			db,
			companyId,
			parentId,
			IssueStatus.Backlog,
			IssueStatus.Done,
			null,
			undefined,
		);

		const after = await db.query<{ count: string }>(
			'SELECT count(*)::text AS count FROM issue_comments WHERE issue_id = $1',
			[parentId],
		);
		expect(Number.parseInt(after.rows[0].count, 10)).toBe(
			Number.parseInt(before.rows[0].count, 10) + 1,
		);
		const sysComment = await db.query<{ content: { kind?: string; from?: string; to?: string } }>(
			`SELECT content FROM issue_comments
			 WHERE issue_id = $1 AND content_type = 'system'
			 ORDER BY created_at DESC LIMIT 1`,
			[parentId],
		);
		expect(sysComment.rows[0]?.content.kind).toBe('status_change');
		expect(sysComment.rows[0]?.content.to).toBe(IssueStatus.Done);
	});
});
