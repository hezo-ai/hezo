import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

interface RunRow {
	id: string;
	trigger_source: string | null;
	trigger_payload: Record<string, unknown> | null;
	trigger_comment_id: string | null;
	trigger_actor_member_id: string | null;
	trigger_actor_slug: string | null;
	trigger_actor_title: string | null;
	trigger_comment_issue_id: string | null;
	trigger_comment_issue_identifier: string | null;
	trigger_comment_project_slug: string | null;
}

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let companyId: string;
let projectId: string;
let architectId: string;
let productLeadId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	void masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Trigger Reason Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Test Project', description: 'x' }),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertIssue(assigneeId: string, title: string): Promise<string> {
	const meta = await db.query<{ issue_prefix: string; number: number }>(
		`SELECT p.issue_prefix, next_project_issue_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::issue_status, 'medium'::issue_priority, '[]'::jsonb)
		 RETURNING id`,
		[companyId, projectId, assigneeId, n, `${meta.rows[0].issue_prefix}-${n}`, title],
	);
	return res.rows[0].id;
}

async function insertWakeup(
	memberId: string,
	source: string,
	payload: Record<string, unknown>,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, payload, claimed_at)
		 VALUES ($1, $2, $3::wakeup_source, 'completed'::wakeup_status, $4::jsonb, now())
		 RETURNING id`,
		[memberId, companyId, source, JSON.stringify(payload)],
	);
	return r.rows[0].id;
}

async function insertRun(
	memberId: string,
	wakeupId: string,
	issueId: string | null,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, wakeup_id, status, started_at, finished_at)
		 VALUES ($1, $2, $3, $4, 'succeeded'::heartbeat_run_status, now() - interval '1 minute', now())
		 RETURNING id`,
		[memberId, companyId, issueId, wakeupId],
	);
	return r.rows[0].id;
}

async function insertComment(
	issueId: string,
	authorMemberId: string | null,
	text: string,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING id`,
		[issueId, authorMemberId, CommentContentType.Text, JSON.stringify({ text })],
	);
	return r.rows[0].id;
}

async function fetchRun(agentId: string, runId: string): Promise<RunRow> {
	const res = await app.request(
		`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs/${runId}`,
		{ headers: authHeader(token) },
	);
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

describe('GET /heartbeat-runs/:runId trigger reason', () => {
	it('resolves mention trigger to actor + issue + comment', async () => {
		const issueId = await insertIssue(architectId, 'Issue with mention');
		const commentId = await insertComment(issueId, productLeadId, '@architect please review');
		const wakeupId = await insertWakeup(architectId, WakeupSource.Mention, {
			source: WakeupSource.Mention,
			issue_id: issueId,
			comment_id: commentId,
		});
		const runId = await insertRun(architectId, wakeupId, issueId);

		const run = await fetchRun(architectId, runId);
		expect(run.trigger_source).toBe(WakeupSource.Mention);
		expect(run.trigger_comment_id).toBe(commentId);
		expect(run.trigger_actor_member_id).toBe(productLeadId);
		expect(run.trigger_actor_slug).toBe('product-lead');
		expect(run.trigger_comment_issue_id).toBe(issueId);
		expect(run.trigger_comment_issue_identifier).toBeTruthy();
		expect(run.trigger_comment_project_slug).toBe('test-project');
	});

	it('resolves reply trigger via the new comment author', async () => {
		const issueId = await insertIssue(productLeadId, 'Issue with reply');
		const originalCommentId = await insertComment(issueId, productLeadId, 'original');
		const replyCommentId = await insertComment(issueId, architectId, 'replying back');
		const wakeupId = await insertWakeup(productLeadId, WakeupSource.Reply, {
			source: WakeupSource.Reply,
			issue_id: issueId,
			comment_id: replyCommentId,
			triggering_comment_id: originalCommentId,
			responder_member_id: architectId,
		});
		const runId = await insertRun(productLeadId, wakeupId, issueId);

		const run = await fetchRun(productLeadId, runId);
		expect(run.trigger_source).toBe(WakeupSource.Reply);
		expect(run.trigger_comment_id).toBe(replyCommentId);
		expect(run.trigger_actor_slug).toBe('architect');
	});

	it('returns null trigger fields for legacy runs without wakeup_id', async () => {
		const issueId = await insertIssue(architectId, 'Legacy run issue');
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now() - interval '1 minute', now())
			 RETURNING id`,
			[architectId, companyId, issueId],
		);
		const run = await fetchRun(architectId, r.rows[0].id);
		expect(run.trigger_source).toBeNull();
		expect(run.trigger_comment_id).toBeNull();
		expect(run.trigger_actor_slug).toBeNull();
	});

	it('returns trigger_source for non-comment wakeup sources without resolved comment fields', async () => {
		const issueId = await insertIssue(architectId, 'Assignment issue');
		const wakeupId = await insertWakeup(architectId, WakeupSource.Assignment, {
			issue_id: issueId,
		});
		const runId = await insertRun(architectId, wakeupId, issueId);

		const run = await fetchRun(architectId, runId);
		expect(run.trigger_source).toBe(WakeupSource.Assignment);
		expect(run.trigger_comment_id).toBeNull();
		expect(run.trigger_actor_slug).toBeNull();
	});

	it('returns heartbeat trigger for scheduled-heartbeat wakeups', async () => {
		const wakeupId = await insertWakeup(architectId, WakeupSource.Heartbeat, {
			reason: 'scheduled_heartbeat',
		});
		const runId = await insertRun(architectId, wakeupId, null);

		const run = await fetchRun(architectId, runId);
		expect(run.trigger_source).toBe(WakeupSource.Heartbeat);
		expect(run.trigger_payload).toMatchObject({ reason: 'scheduled_heartbeat' });
	});
});
