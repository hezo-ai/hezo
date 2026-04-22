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

describe('MCP create_comment fires mention-only wakeups', () => {
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

	it('does not wake the assignee when a plain (non-mentioning) comment is posted', async () => {
		const { issueId, agentToken } = await setup(architectId, productLeadId, 'Architecture task');
		const commentId = await postMcpComment(agentToken, issueId, 'Added context for you.');

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('wakes only @-mentioned agents, not the assignee, on a mention-bearing comment', async () => {
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
		expect(mentionTargets).toEqual([architectId]);
		expect(wakeups.some((w) => w.source === WakeupSource.Comment)).toBe(false);
	});

	it('skips self-mentions', async () => {
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

describe('agent-api POST comments fires mention-only wakeups', () => {
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

	it('does not wake the assignee on a plain agent-api comment from a different agent', async () => {
		const { issueId, agentToken } = await setup(architectId, productLeadId, 'Architecture task 2');
		const commentId = await postAgentApiComment(agentToken, issueId, 'More context for you here.');

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
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

describe('board POST comments honors wake_assignee opt-in', () => {
	async function postBoardComment(issueId: string, body: Record<string, unknown>): Promise<string> {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data.id;
	}

	it('wakes the assignee when wake_assignee is true', async () => {
		const issueId = await insertIssue(architectId, 'Board wake true');
		const commentId = await postBoardComment(issueId, {
			content_type: CommentContentType.Text,
			content: { text: 'Take a look when you can.' },
			wake_assignee: true,
		});

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toHaveLength(1);
		expect(wakeups[0].source).toBe(WakeupSource.Comment);
		expect(wakeups[0].member_id).toBe(architectId);
		expect(wakeups[0].payload.issue_id).toBe(issueId);
		expect(wakeups[0].payload.comment_id).toBe(commentId);
	});

	it('does not wake the assignee when wake_assignee is false', async () => {
		const issueId = await insertIssue(architectId, 'Board wake false');
		const commentId = await postBoardComment(issueId, {
			content_type: CommentContentType.Text,
			content: { text: 'Just a note.' },
			wake_assignee: false,
		});

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('does not wake the assignee when wake_assignee is omitted', async () => {
		const issueId = await insertIssue(architectId, 'Board wake omitted');
		const commentId = await postBoardComment(issueId, {
			content_type: CommentContentType.Text,
			content: { text: 'No flag at all.' },
		});

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});

	it('does not double-fire when the assignee is also @-mentioned', async () => {
		const issueId = await insertIssue(architectId, 'Board wake mention overlap');
		const commentId = await postBoardComment(issueId, {
			content_type: CommentContentType.Text,
			content: { text: '@architect please weigh in.' },
			wake_assignee: true,
		});

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toHaveLength(1);
		expect(wakeups[0].source).toBe(WakeupSource.Mention);
		expect(wakeups[0].member_id).toBe(architectId);
	});

	it('ignores wake_assignee when posted via the agent-api', async () => {
		const { issueId, agentToken } = await setup(architectId, productLeadId, 'Agent flag ignored');
		const res = await app.request(`/agent-api/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: CommentContentType.Text,
				content: { text: 'Plain agent comment.' },
				wake_assignee: true,
			}),
		});
		expect(res.status).toBe(201);
		const commentId = (await res.json()).data.id;

		const wakeups = await wakeupsForComment(commentId);
		expect(wakeups).toEqual([]);
	});
});

describe('reply wakeups from mention-triggered runs', () => {
	async function mintTriggeringMention(params: {
		issueId: string;
		triggeringCommentId: string;
		mentionedAgentId: string;
	}): Promise<{ runId: string; token: string }> {
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, company_id, source, payload)
			 VALUES ($1, $2, 'mention'::wakeup_source, $3::jsonb)
			 RETURNING id`,
			[
				params.mentionedAgentId,
				companyId,
				JSON.stringify({
					source: WakeupSource.Mention,
					issue_id: params.issueId,
					comment_id: params.triggeringCommentId,
				}),
			],
		);
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, wakeup_id, status, started_at)
			 VALUES ($1, $2, $3, $4, 'running'::heartbeat_run_status, now())
			 RETURNING id`,
			[params.mentionedAgentId, companyId, params.issueId, wakeup.rows[0].id],
		);
		const { signAgentJwt } = await import('../../middleware/auth');
		const token = await signAgentJwt(
			masterKeyManager,
			params.mentionedAgentId,
			companyId,
			run.rows[0].id,
		);
		return { runId: run.rows[0].id, token };
	}

	async function insertMentionComment(
		issueId: string,
		authorMemberId: string,
		text: string,
	): Promise<string> {
		const res = await db.query<{ id: string }>(
			`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
			 RETURNING id`,
			[issueId, authorMemberId, JSON.stringify({ text })],
		);
		return res.rows[0].id;
	}

	async function setCompanySetting(key: string, value: unknown): Promise<void> {
		await db.query(`UPDATE companies SET settings = settings || $1::jsonb WHERE id = $2`, [
			JSON.stringify({ [key]: value }),
			companyId,
		]);
	}

	beforeEach(async () => {
		await db.query('DELETE FROM agent_wakeup_requests');
		await db.query('DELETE FROM heartbeat_runs');
		await db.query('DELETE FROM issue_comments');
		await setCompanySetting('wake_mentioner_on_reply', true);
	});

	it('wakes the original mentioner when the mentioned agent replies in the triggering ticket', async () => {
		const issueId = await insertIssue(ceoId, 'Reply wakeup basic');
		const triggeringCommentId = await insertMentionComment(
			issueId,
			ceoId,
			'@architect please take a look.',
		);
		const { token: architectToken } = await mintTriggeringMention({
			issueId,
			triggeringCommentId,
			mentionedAgentId: architectId,
		});

		const replyId = await postMcpComment(
			architectToken,
			issueId,
			"On it — I've opened a ticket to carry this forward.",
		);

		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toHaveLength(1);
		const reply = wakeups.find((w) => w.source === WakeupSource.Reply)!;
		expect(reply.member_id).toBe(ceoId);
		expect(reply.payload.issue_id).toBe(issueId);
		expect(reply.payload.comment_id).toBe(replyId);
		expect((reply.payload as Record<string, unknown>).triggering_comment_id).toBe(
			triggeringCommentId,
		);
		expect((reply.payload as Record<string, unknown>).responder_member_id).toBe(architectId);
	});

	it('also fires when the reply is posted via the agent-api', async () => {
		const issueId = await insertIssue(ceoId, 'Reply wakeup agent-api');
		const triggeringCommentId = await insertMentionComment(issueId, ceoId, '@architect thoughts?');
		const { token: architectToken } = await mintTriggeringMention({
			issueId,
			triggeringCommentId,
			mentionedAgentId: architectId,
		});

		const replyId = await postAgentApiComment(architectToken, issueId, 'Acknowledged.');
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.some((w) => w.source === WakeupSource.Reply && w.member_id === ceoId)).toBe(
			true,
		);
	});

	it('does not wake the mentioner when the reply is posted on a different issue', async () => {
		const issueA = await insertIssue(ceoId, 'Reply wakeup A');
		const issueB = await insertIssue(architectId, 'Reply wakeup B (different)');
		const triggeringCommentId = await insertMentionComment(
			issueA,
			ceoId,
			'@architect please take a look.',
		);
		const { token: architectToken } = await mintTriggeringMention({
			issueId: issueA,
			triggeringCommentId,
			mentionedAgentId: architectId,
		});

		const replyId = await postMcpComment(architectToken, issueB, 'Picking this up elsewhere.');
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toEqual([]);
	});

	it('does not wake the mentioner when the original comment author is a Board (human) user', async () => {
		const issueId = await insertIssue(architectId, 'Board mentioner no wake');
		const triggeringCommentId = await db.query<{ id: string }>(
			`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text'::comment_content_type, $2::jsonb)
			 RETURNING id`,
			[issueId, JSON.stringify({ text: '@architect please help' })],
		);
		const { token: architectToken } = await mintTriggeringMention({
			issueId,
			triggeringCommentId: triggeringCommentId.rows[0].id,
			mentionedAgentId: architectId,
		});

		const replyId = await postMcpComment(architectToken, issueId, 'Looking into it.');
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toEqual([]);
	});

	it('suppresses reply wakeups when wake_mentioner_on_reply is false', async () => {
		await setCompanySetting('wake_mentioner_on_reply', false);
		const issueId = await insertIssue(ceoId, 'Reply wakeup disabled');
		const triggeringCommentId = await insertMentionComment(
			issueId,
			ceoId,
			'@architect please take a look.',
		);
		const { token: architectToken } = await mintTriggeringMention({
			issueId,
			triggeringCommentId,
			mentionedAgentId: architectId,
		});

		const replyId = await postMcpComment(architectToken, issueId, 'Following up.');
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toEqual([]);
	});

	it('dedupes reply wakeups with mention wakeups when the reply also @-mentions the original author', async () => {
		const issueId = await insertIssue(ceoId, 'Reply overlap mention');
		const triggeringCommentId = await insertMentionComment(
			issueId,
			ceoId,
			'@architect please take a look.',
		);
		const { token: architectToken } = await mintTriggeringMention({
			issueId,
			triggeringCommentId,
			mentionedAgentId: architectId,
		});

		const replyId = await postMcpComment(
			architectToken,
			issueId,
			'@ceo done — follow-up in new ticket.',
		);

		const wakeups = await wakeupsForComment(replyId);
		const ceoWakeups = wakeups.filter((w) => w.member_id === ceoId);
		expect(ceoWakeups).toHaveLength(1);
		expect(ceoWakeups[0].source).toBe(WakeupSource.Mention);
	});

	it('does nothing when the run was not a mention-triggered run', async () => {
		const issueId = await insertIssue(architectId, 'Assignment run');
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, company_id, source, payload)
			 VALUES ($1, $2, 'assignment'::wakeup_source, $3::jsonb)
			 RETURNING id`,
			[architectId, companyId, JSON.stringify({ issue_id: issueId })],
		);
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, wakeup_id, status, started_at)
			 VALUES ($1, $2, $3, $4, 'running'::heartbeat_run_status, now())
			 RETURNING id`,
			[architectId, companyId, issueId, wakeup.rows[0].id],
		);
		const { signAgentJwt } = await import('../../middleware/auth');
		const architectToken = await signAgentJwt(
			masterKeyManager,
			architectId,
			companyId,
			run.rows[0].id,
		);

		const replyId = await postMcpComment(architectToken, issueId, 'Progress update.');
		const wakeups = await wakeupsForComment(replyId);
		expect(wakeups.filter((w) => w.source === WakeupSource.Reply)).toEqual([]);
	});
});
