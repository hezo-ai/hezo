import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, ReactionKind } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let companyId: string;
let projectId: string;
let ceoId: string;
let architectId: string;
let productLeadId: string;
let ceoSlug: string;

interface ReactionMember {
	id: string;
	slug: string | null;
	display_name: string | null;
}
interface ReactionGroup {
	kind: string;
	members: ReactionMember[];
}

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

async function insertComment(issueId: string, authorMemberId: string | null): Promise<string> {
	const res = await db.query<{ id: string }>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[issueId, authorMemberId, JSON.stringify({ text: '@architect please review' })],
	);
	return res.rows[0].id;
}

async function callMcp(
	agentToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<{ status: number; result: unknown }> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	const text = body.result?.content?.[0]?.text ?? '{}';
	return { status: res.status, result: JSON.parse(text) };
}

async function reactionsRowCount(commentId: string): Promise<number> {
	const r = await db.query<{ c: number }>(
		'SELECT COUNT(*)::int AS c FROM comment_reactions WHERE comment_id = $1',
		[commentId],
	);
	return r.rows[0].c;
}

async function wakeupCount(): Promise<number> {
	const r = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM agent_wakeup_requests');
	return r.rows[0].c;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Reactions Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	const ceo = agents.find((a) => a.slug === 'ceo')!;
	ceoId = ceo.id;
	ceoSlug = ceo.slug;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Reactions Project', description: 'x' }),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM comment_reactions');
	await db.query('DELETE FROM agent_wakeup_requests');
});

describe('REST reactions endpoints', () => {
	it('PUT adds a reaction; idempotent on repeat', async () => {
		const issueId = await insertIssue(ceoId, 'Reaction test');
		const commentId = await insertComment(issueId, productLeadId);

		const url = `/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/reactions/${ReactionKind.Ack}`;
		const first = await app.request(url, { method: 'PUT', headers: authHeader(token) });
		expect(first.status).toBe(200);
		const firstBody = (await first.json()).data as {
			kind: string;
			reactions: ReactionGroup[];
		};
		expect(firstBody.kind).toBe(ReactionKind.Ack);
		expect(firstBody.reactions).toHaveLength(1);
		expect(firstBody.reactions[0].kind).toBe(ReactionKind.Ack);
		expect(firstBody.reactions[0].members).toHaveLength(1);

		const second = await app.request(url, { method: 'PUT', headers: authHeader(token) });
		expect(second.status).toBe(200);
		expect(await reactionsRowCount(commentId)).toBe(1);
	});

	it('DELETE removes only the caller’s reaction', async () => {
		const issueId = await insertIssue(ceoId, 'Reaction delete test');
		const commentId = await insertComment(issueId, productLeadId);

		// Architect (an agent) reacts via MCP
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			companyId,
			issueId,
		);
		const arc = await callMcp(architectToken, 'add_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		expect(arc.status).toBe(200);
		expect((arc.result as { error?: string }).error).toBeUndefined();

		// Board user reacts via REST
		const putUrl = `/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/reactions/${ReactionKind.Ack}`;
		await app.request(putUrl, { method: 'PUT', headers: authHeader(token) });
		expect(await reactionsRowCount(commentId)).toBe(2);

		// Board user removes their own — architect's stays
		const del = await app.request(putUrl, { method: 'DELETE', headers: authHeader(token) });
		expect(del.status).toBe(200);
		expect(await reactionsRowCount(commentId)).toBe(1);
		const remaining = await db.query<{ member_id: string }>(
			'SELECT member_id FROM comment_reactions WHERE comment_id = $1',
			[commentId],
		);
		expect(remaining.rows[0].member_id).toBe(architectId);
	});

	it('400 on unknown reaction kind', async () => {
		const issueId = await insertIssue(ceoId, 'Invalid kind test');
		const commentId = await insertComment(issueId, productLeadId);

		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/reactions/nope`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
	});

	it('404 when comment does not belong to the issue', async () => {
		const issueA = await insertIssue(ceoId, 'Cross-issue A');
		const issueB = await insertIssue(ceoId, 'Cross-issue B');
		const commentInA = await insertComment(issueA, productLeadId);

		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueB}/comments/${commentInA}/reactions/${ReactionKind.Ack}`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('reacting does not create any wakeups', async () => {
		const issueId = await insertIssue(ceoId, 'No wakeup test');
		const commentId = await insertComment(issueId, productLeadId);

		const before = await wakeupCount();
		await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/reactions/${ReactionKind.Ack}`,
			{ method: 'PUT', headers: authHeader(token) },
		);
		await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/reactions/${ReactionKind.Ack}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(await wakeupCount()).toBe(before);
	});

	it('GET /comments includes reactions inline', async () => {
		const issueId = await insertIssue(ceoId, 'GET with reactions');
		const commentId = await insertComment(issueId, productLeadId);

		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			companyId,
			issueId,
		);
		await callMcp(ceoToken, 'add_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});

		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{
			id: string;
			reactions: ReactionGroup[];
		}>;
		const c = rows.find((r) => r.id === commentId);
		expect(c).toBeDefined();
		expect(c!.reactions).toHaveLength(1);
		expect(c!.reactions[0].kind).toBe(ReactionKind.Ack);
		expect(c!.reactions[0].members[0].slug).toBe(ceoSlug);
	});

	it('cross-company access is denied', async () => {
		const issueId = await insertIssue(ceoId, 'Cross-company test');
		const commentId = await insertComment(issueId, productLeadId);

		// Build a second company; mint an api key for it.
		const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;
		const otherCompany = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Other Co', template_id: typeId }),
		});
		const otherCompanyId = (await otherCompany.json()).data.id;
		const otherAgents = await app.request(`/api/companies/${otherCompanyId}/agents`, {
			headers: authHeader(token),
		});
		const otherCeo = (await otherAgents.json()).data.find(
			(a: { slug: string }) => a.slug === 'ceo',
		);
		const otherIssue = await db.query<{ id: string }>(
			`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
			 SELECT $1, p.id, $2, 1, 'OTH-1', 'other', 'backlog'::issue_status, 'medium'::issue_priority, '[]'::jsonb
			 FROM projects p WHERE p.company_id = $1 LIMIT 1
			 RETURNING id`,
			[otherCompanyId, otherCeo.id],
		);
		const { token: otherToken } = await mintAgentToken(
			db,
			masterKeyManager,
			otherCeo.id,
			otherCompanyId,
			otherIssue.rows[0].id,
		);

		const res = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/reactions/${ReactionKind.Ack}`,
			{ method: 'PUT', headers: authHeader(otherToken) },
		);
		expect(res.status).toBe(403);
	});
});

describe('MCP add_reaction / remove_reaction tools', () => {
	it('add_reaction is idempotent', async () => {
		const issueId = await insertIssue(ceoId, 'MCP idempotent');
		const commentId = await insertComment(issueId, productLeadId);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			companyId,
			issueId,
		);

		const first = await callMcp(agentToken, 'add_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		expect((first.result as { error?: string }).error).toBeUndefined();
		const second = await callMcp(agentToken, 'add_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		expect((second.result as { error?: string }).error).toBeUndefined();
		expect(await reactionsRowCount(commentId)).toBe(1);
	});

	it('remove_reaction removes only the caller’s reaction', async () => {
		const issueId = await insertIssue(ceoId, 'MCP remove');
		const commentId = await insertComment(issueId, productLeadId);
		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			companyId,
			issueId,
		);
		const { token: archToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			companyId,
			issueId,
		);
		await callMcp(ceoToken, 'add_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		await callMcp(archToken, 'add_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		await callMcp(ceoToken, 'remove_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		const rows = await db.query<{ member_id: string }>(
			'SELECT member_id FROM comment_reactions WHERE comment_id = $1',
			[commentId],
		);
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0].member_id).toBe(architectId);
	});

	it('list_comments includes reactions inline', async () => {
		const issueId = await insertIssue(ceoId, 'MCP list_comments');
		const commentId = await insertComment(issueId, productLeadId);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			companyId,
			issueId,
		);
		await callMcp(agentToken, 'add_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		const list = await callMcp(agentToken, 'list_comments', {
			company_id: companyId,
			issue_id: issueId,
		});
		const rows = list.result as Array<{ id: string; reactions: ReactionGroup[] }>;
		const c = rows.find((r) => r.id === commentId)!;
		expect(c.reactions).toHaveLength(1);
		expect(c.reactions[0].kind).toBe(ReactionKind.Ack);
	});

	it('add_reaction does not fire any wakeups', async () => {
		const issueId = await insertIssue(architectId, 'MCP no wakeups');
		const commentId = await insertComment(issueId, ceoId);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			companyId,
			issueId,
		);

		const before = await wakeupCount();
		await callMcp(agentToken, 'add_reaction', {
			company_id: companyId,
			issue_id: issueId,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		});
		expect(await wakeupCount()).toBe(before);
	});
});
