import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, WakeupSource } from '@hezo/shared';
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
let productLeadId: string;
let architectId: string;
let ceoId: string;

interface WakeupRow {
	id: string;
	member_id: string;
	source: string;
	payload: { source?: string; issue_id?: string; comment_id?: string };
}

async function wakeupsForComment(commentId: string): Promise<WakeupRow[]> {
	const res = await db.query<WakeupRow>(
		`SELECT id, member_id, source::text AS source, payload
		 FROM agent_wakeup_requests
		 WHERE payload->>'comment_id' = $1
		 ORDER BY created_at ASC`,
		[commentId],
	);
	return res.rows;
}

// Inserts an issue directly so no side-effect wakeups fire (the REST
// create-issue path queues an assignment wakeup that would coalesce with
// the comment wakeups we're trying to observe).
async function insertIssue(assigneeId: string, title: string): Promise<string> {
	const number = await db.query<{ number: number }>('SELECT next_issue_number($1) AS number', [
		companyId,
	]);
	const n = number.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::issue_status, 'medium'::issue_priority, '[]'::jsonb)
		 RETURNING id`,
		[companyId, projectId, assigneeId, n, `CW-${n}`, title],
	);
	return res.rows[0].id;
}

async function setup(
	assigneeId: string,
	authorAgentId: string,
	title: string,
): Promise<{ issueId: string; agentToken: string }> {
	const issueId = await insertIssue(assigneeId, title);
	const { token: agentToken } = await mintAgentToken(
		db,
		masterKeyManager,
		authorAgentId,
		companyId,
		issueId,
	);
	return { issueId, agentToken };
}

async function postMcpComment(
	agentToken: string,
	issueId: string,
	content: string,
): Promise<string> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: {
				name: 'create_comment',
				arguments: { company_id: companyId, issue_id: issueId, content },
			},
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	const inserted = JSON.parse(body.result.content[0].text) as { id: string };
	return inserted.id;
}

async function postAgentApiComment(
	agentToken: string,
	issueId: string,
	text: string,
): Promise<string> {
	const res = await app.request(`/agent-api/issues/${issueId}/comments`, {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			content_type: CommentContentType.Text,
			content: { text },
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
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
		body: JSON.stringify({
			name: 'Comment Wakeups Co',
			template_id: typeId,
			issue_prefix: 'CW',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	ceoId = agents.find((a) => a.slug === 'ceo')!.id;
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

beforeEach(async () => {
	await db.query('DELETE FROM agent_wakeup_requests');
});

describe('MCP create_comment fires mention + assignee wakeups', () => {
	it('wakes a mentioned agent who is not the author or assignee', async () => {
		const { issueId, agentToken } = await setup(ceoId, productLeadId, 'CEO roadmap ticket');
		const commentId = await postMcpComment(
			agentToken,
			issueId,
			'@architect please review the PRD when you get a chance.',
		);

		const wakeups = await wakeupsForComment(commentId);
		const mention = wakeups.find(
			(w) => w.source === WakeupSource.Mention && w.member_id === architectId,
		);
		expect(mention).toBeDefined();
		expect(mention?.payload.source).toBe(WakeupSource.Mention);
		expect(mention?.payload.issue_id).toBe(issueId);
	});

	it('wakes the assignee when a different agent posts a comment', async () => {
		const { issueId, agentToken } = await setup(architectId, productLeadId, 'Architecture task');
		const commentId = await postMcpComment(agentToken, issueId, 'Added context for you.');

		const wakeups = await wakeupsForComment(commentId);
		const comment = wakeups.find(
			(w) => w.source === WakeupSource.Comment && w.member_id === architectId,
		);
		expect(comment).toBeDefined();
		expect(wakeups.some((w) => w.source === WakeupSource.Mention)).toBe(false);
	});

	it('fires both mention and assignee wakeups on the same comment', async () => {
		const { issueId, agentToken } = await setup(ceoId, productLeadId, 'Cross-team ticket');
		const commentId = await postMcpComment(
			agentToken,
			issueId,
			'@architect take a look — CEO please weigh in.',
		);

		const wakeups = await wakeupsForComment(commentId);
		const mentionTargets = wakeups
			.filter((w) => w.source === WakeupSource.Mention)
			.map((w) => w.member_id);
		const commentTargets = wakeups
			.filter((w) => w.source === WakeupSource.Comment)
			.map((w) => w.member_id);
		expect(mentionTargets).toEqual([architectId]);
		expect(commentTargets).toEqual([ceoId]);
	});

	it('skips self-mentions and self-comments', async () => {
		const { issueId, agentToken } = await setup(architectId, architectId, 'Architect own ticket');
		const commentId = await postMcpComment(
			agentToken,
			issueId,
			'@architect reminding myself to do this.',
		);

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('ignores @mentions inside fenced code blocks', async () => {
		const { issueId, agentToken } = await setup(ceoId, productLeadId, 'PRD draft');
		const commentId = await postMcpComment(
			agentToken,
			issueId,
			'Example snippet:\n```\nsend to @architect later\n```\nno real mention here.',
		);

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups.some((w) => w.member_id === architectId)).toBe(false);
	});

	it('does not wake an unknown slug', async () => {
		const { issueId, agentToken } = await setup(ceoId, productLeadId, 'Unknown mention');
		const commentId = await postMcpComment(agentToken, issueId, '@not-a-real-agent please help');

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Mention)).toEqual([]);
	});
});

describe('agent-api POST comments fires mention + assignee wakeups', () => {
	it('wakes a mentioned agent on an agent-api-posted comment', async () => {
		const { issueId, agentToken } = await setup(ceoId, productLeadId, 'CEO roadmap ticket 2');
		const commentId = await postAgentApiComment(
			agentToken,
			issueId,
			'@architect could you weigh in on §FR-20?',
		);

		const wakeups = await wakeupsForComment(commentId);
		const mention = wakeups.find(
			(w) => w.source === WakeupSource.Mention && w.member_id === architectId,
		);
		expect(mention).toBeDefined();
	});

	it('wakes the assignee on an agent-api-posted comment from a different agent', async () => {
		const { issueId, agentToken } = await setup(architectId, productLeadId, 'Architecture task 2');
		const commentId = await postAgentApiComment(agentToken, issueId, 'More context for you here.');

		const wakeups = await wakeupsForComment(commentId);
		const comment = wakeups.find(
			(w) => w.source === WakeupSource.Comment && w.member_id === architectId,
		);
		expect(comment).toBeDefined();
	});

	it('skips non-text content types even when they contain @-mentions', async () => {
		const { issueId, agentToken } = await setup(ceoId, productLeadId, 'Trace ticket');
		const res = await app.request(`/agent-api/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: CommentContentType.Trace,
				content: { text: '@architect tool output' },
			}),
		});
		expect(res.status).toBe(201);
		const commentId = (await res.json()).data.id;

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});
});
