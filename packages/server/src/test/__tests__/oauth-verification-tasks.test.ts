import type { PGlite } from '@electric-sql/pglite';
import { IssueStatus, PlatformType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
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
		body: JSON.stringify({ name: 'OAuth Verif Co', template_id: typeId }),
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

beforeEach(async () => {
	await db.query(`DELETE FROM issues WHERE labels @> '["oauth-verification"]'::jsonb`);
});

describe('enqueueOAuthVerificationTask', () => {
	it('creates an Operations issue assigned to the CEO with high priority and the label', async () => {
		const result = await enqueueOAuthVerificationTask(db, companyId, PlatformType.GitHub, null, {
			username: 'octocat',
		});
		expect(result).toBeTruthy();
		expect(result?.created).toBe(true);

		const row = await db.query<{
			project_id: string;
			assignee_id: string;
			parent_issue_id: string | null;
			title: string;
			description: string;
			labels: string[];
			priority: string;
			status: string;
		}>(
			`SELECT project_id, assignee_id, parent_issue_id, title, description, labels, priority, status
			 FROM issues WHERE id = $1`,
			[result!.issueId],
		);
		const issue = row.rows[0];
		expect(issue.assignee_id).toBe(ceoMemberId);
		expect(issue.parent_issue_id).toBeNull();

		const ops = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE company_id = $1 AND slug = 'operations'`,
			[companyId],
		);
		expect(issue.project_id).toBe(ops.rows[0].id);

		expect(issue.labels).toEqual(expect.arrayContaining(['internal', 'oauth-verification']));
		expect(issue.priority).toBe('high');
		expect(issue.status).toBe('backlog');
		expect(issue.title).toContain('GitHub');
		expect(issue.description).toContain('oauth-verify platform=github');
		expect(issue.description).toContain('octocat');
	});

	it('links the new issue to the originating issue via parent_issue_id', async () => {
		const meta = await db.query<{ issue_prefix: string; number: number }>(
			`SELECT p.issue_prefix, next_project_issue_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[parentProjectId],
		);
		const parent = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO issues (company_id, project_id, number, identifier, title)
			 VALUES ($1, $2, $3, $4, 'Originating ticket')
			 RETURNING id, identifier`,
			[
				companyId,
				parentProjectId,
				meta.rows[0].number,
				`${meta.rows[0].issue_prefix}-${meta.rows[0].number}`,
			],
		);
		const parentId = parent.rows[0].id;

		const result = await enqueueOAuthVerificationTask(
			db,
			companyId,
			PlatformType.GitHub,
			parentId,
			{},
		);
		expect(result?.created).toBe(true);

		const row = await db.query<{ parent_issue_id: string | null; description: string }>(
			'SELECT parent_issue_id, description FROM issues WHERE id = $1',
			[result!.issueId],
		);
		expect(row.rows[0].parent_issue_id).toBe(parentId);
		expect(row.rows[0].description).toContain(parent.rows[0].identifier);
	});

	it('dedups by returning the existing open issue and posting a system comment', async () => {
		const first = await enqueueOAuthVerificationTask(db, companyId, PlatformType.GitHub, null, {});
		const second = await enqueueOAuthVerificationTask(db, companyId, PlatformType.GitHub, null, {});
		expect(second?.issueId).toBe(first?.issueId);
		expect(second?.created).toBe(false);

		const comments = await db.query<{ content_type: string }>(
			'SELECT content_type FROM issue_comments WHERE issue_id = $1',
			[first!.issueId],
		);
		expect(comments.rows.some((c) => c.content_type === 'system')).toBe(true);
	});

	it('creates a wakeup for the CEO when enqueueing', async () => {
		const result = await enqueueOAuthVerificationTask(db, companyId, PlatformType.GitHub, null, {});
		const wakeups = await db.query<{ source: string; payload: Record<string, unknown> }>(
			`SELECT source, payload FROM agent_wakeup_requests WHERE member_id = $1`,
			[ceoMemberId],
		);
		expect(
			wakeups.rows.some((w) => w.source === 'assignment' && w.payload.issue_id === result!.issueId),
		).toBe(true);
	});

	it('creates a separate issue per platform', async () => {
		const github = await enqueueOAuthVerificationTask(db, companyId, PlatformType.GitHub, null, {});
		const stripe = await enqueueOAuthVerificationTask(db, companyId, PlatformType.Stripe, null, {});
		expect(github?.issueId).not.toBe(stripe?.issueId);
		expect(github?.created).toBe(true);
		expect(stripe?.created).toBe(true);
	});

	it('closes the dedup window when the prior issue reaches a terminal status', async () => {
		const first = await enqueueOAuthVerificationTask(db, companyId, PlatformType.GitHub, null, {});
		await db.query('UPDATE issues SET status = $1::issue_status WHERE id = $2', [
			IssueStatus.Done,
			first!.issueId,
		]);
		const second = await enqueueOAuthVerificationTask(db, companyId, PlatformType.GitHub, null, {});
		expect(second?.issueId).not.toBe(first?.issueId);
		expect(second?.created).toBe(true);
	});
});
