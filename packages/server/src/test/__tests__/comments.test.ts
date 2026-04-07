import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { signAgentJwt } from '../../middleware/auth';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;
let issueId: string;
let agentId: string;
let agentSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Comment Co', issue_prefix: 'CC' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main' }),
	});
	projectId = (await projectRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Test Issue' }),
	});
	issueId = (await issueRes.json()).data.id;

	// Create an agent for mention/wakeup testing
	const agentRes = await app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Comment Bot' }),
	});
	const agent = (await agentRes.json()).data;
	agentId = agent.id;
	agentSlug = agent.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('comments CRUD', () => {
	it('creates a text comment', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Hello world' },
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content_type).toBe('text');
		expect(body.data.content.text).toBe('Hello world');
	});

	it('lists comments in order', async () => {
		// Add another comment
		await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Second comment' },
			}),
		});

		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		// Ordered by created_at ASC
		expect(body.data[0].content.text).toBe('Hello world');
	});

	it('creates an options comment and chooses an option', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'options',
				content: {
					prompt: 'Which approach?',
					options: [
						{ id: 'a', label: 'Option A' },
						{ id: 'b', label: 'Option B' },
					],
				},
			}),
		});
		expect(createRes.status).toBe(201);
		const comment = (await createRes.json()).data;

		const chooseRes = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${comment.id}/choose`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ chosen_id: 'a' }),
			},
		);
		expect(chooseRes.status).toBe(200);
		const chosenBody = await chooseRes.json();
		expect(chosenBody.data.chosen_option.chosen_id).toBe('a');
	});
});

describe('comment @mention wakeups', () => {
	it('creates a mention wakeup when comment contains @agent-slug', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);

		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `@${agentSlug} take a look at this` },
			}),
		});
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('creates option_chosen wakeup when choosing option on issue assigned to agent', async () => {
		// Create a new issue assigned to the agent
		const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent Assigned Issue',
				assignee_id: agentId,
			}),
		});
		const assignedIssueId = (await issueRes.json()).data.id;

		// Create an options comment
		const commentRes = await app.request(
			`/api/companies/${companyId}/issues/${assignedIssueId}/comments`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					content_type: 'options',
					content: {
						prompt: 'Which?',
						options: [
							{ id: 'x', label: 'X' },
							{ id: 'y', label: 'Y' },
						],
					},
				}),
			},
		);
		const optionsCommentId = (await commentRes.json()).data.id;

		await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);

		// Choose an option
		await app.request(
			`/api/companies/${companyId}/issues/${assignedIssueId}/comments/${optionsCommentId}/choose`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ chosen_id: 'x' }),
			},
		);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'option_chosen'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});
});

describe('comment wakeups on assigned issues', () => {
	let assignedIssueId: string;

	beforeAll(async () => {
		const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Agent Assigned for Comment Test',
				assignee_id: agentId,
			}),
		});
		assignedIssueId = (await issueRes.json()).data.id;
	});

	it('creates comment wakeup when board user comments on agent-assigned issue', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);

		const res = await app.request(
			`/api/companies/${companyId}/issues/${assignedIssueId}/comments`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					content_type: 'text',
					content: { text: 'Please prioritize this' },
				}),
			},
		);
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'comment'",
			[agentId],
		);
		expect(wakeups.rows.length).toBe(1);
		expect((wakeups.rows[0] as any).payload.issue_id).toBe(assignedIssueId);
	});

	it('does not double-notify when comment @-mentions the assigned agent', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);

		const res = await app.request(
			`/api/companies/${companyId}/issues/${assignedIssueId}/comments`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					content_type: 'text',
					content: { text: `@${agentSlug} please check this` },
				}),
			},
		);
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const mentionWakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'mention'",
			[agentId],
		);
		expect(mentionWakeups.rows.length).toBe(1);

		const commentWakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'comment'",
			[agentId],
		);
		expect(commentWakeups.rows.length).toBe(0);
	});

	it('does not self-notify when assigned agent comments on own issue', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);

		const agentToken = await signAgentJwt(masterKeyManager, agentId, companyId);

		const res = await app.request(
			`/api/companies/${companyId}/issues/${assignedIssueId}/comments`,
			{
				method: 'POST',
				headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					content_type: 'text',
					content: { text: 'I am working on this' },
				}),
			},
		);
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'comment'",
			[agentId],
		);
		expect(wakeups.rows.length).toBe(0);
	});
});
