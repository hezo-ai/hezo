import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { buildCoachReviewPrompt, type IssueInfo } from '../../services/agent-runner';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let companyId: string;
let projectId: string;
let issueId: string;
let coachId: string;
let engineerId: string;
let engineerToken: string;
let architectId: string;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(boardToken) });
	const companyTypeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Coach Test Co',
			template_id: companyTypeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Coach Test Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(boardToken),
	});
	const agents = (await agentsRes.json()).data;

	const coach = agents.find((a: any) => a.slug === 'coach');
	const engineer = agents.find((a: any) => a.slug === 'engineer');
	const architect = agents.find((a: any) => a.slug === 'architect');

	expect(coach).toBeTruthy();
	expect(engineer).toBeTruthy();
	expect(architect).toBeTruthy();

	coachId = coach.id;
	engineerId = engineer.id;
	architectId = architect.id;

	({ token: engineerToken } = await mintAgentToken(db, masterKeyManager, engineerId, companyId));

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Test Feature Implementation',
			assignee_id: engineerId,
		}),
	});
	issueId = (await issueRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('Coach agent provisioning', () => {
	it('Coach is auto-provisioned when company is created with Startup template', async () => {
		const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(boardToken),
		});
		const agents = (await agentsRes.json()).data;
		const coach = agents.find((a: any) => a.slug === 'coach');

		expect(coach).toBeTruthy();
		expect(coach.title).toBe('Coach');
		expect(coach.admin_status).toBe('enabled');

		const promptRes = await app.request(
			`/api/companies/${companyId}/agents/${coach.id}/system-prompt`,
			{ headers: authHeader(boardToken) },
		);
		const promptDoc = (await promptRes.json()).data;
		expect(promptDoc?.content).toBeTruthy();
	});

	it('Coach agent type exists in agent_types', async () => {
		const res = await app.request('/api/agent-types', {
			headers: authHeader(boardToken),
		});
		const types = (await res.json()).data;
		const coachType = types.find((t: any) => t.slug === 'coach');

		expect(coachType).toBeTruthy();
		expect(coachType.name).toBe('Coach');
		expect(coachType.is_builtin).toBe(true);
	});
});

describe('Coach wakeup on issue done', () => {
	it('creates a wakeup for Coach when issue is marked done', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});
		expect(res.status).toBe(200);

		// Wait for async wakeup creation (fire-and-forget in the route handler)
		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query<{
			id: string;
			member_id: string;
			source: string;
			payload: { issue_id: string; trigger: string };
		}>(
			`SELECT id, member_id, source, payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = 'automation'
			 ORDER BY created_at DESC LIMIT 1`,
			[coachId],
		);

		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].payload.issue_id).toBe(issueId);
		expect(wakeups.rows[0].payload.trigger).toBe('issue_done');
	});
});

describe('Coach review prompt builder', () => {
	it('instructs the coach to post a single create_comment summarising the review', async () => {
		const issueRow = await db.query<IssueInfo>(
			`SELECT id, identifier, title, description, status::text AS status,
			        priority::text AS priority, project_id, rules,
			        parent_issue_id, created_by_run_id
			 FROM issues WHERE id = $1`,
			[issueId],
		);
		expect(issueRow.rows.length).toBe(1);

		const prompt = await buildCoachReviewPrompt(db, 'SYSTEM_PROMPT', issueRow.rows[0], companyId);

		expect(prompt).toContain('create_comment');
		expect(prompt).toContain(issueRow.rows[0].identifier);
		expect(prompt).toMatch(/summar/i);
		expect(prompt).toContain('no rule changes were warranted');
	});
});

describe('MCP tools registration', () => {
	it('registers get_agent_system_prompt and update_agent_system_prompt tools', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('get_agent_system_prompt');
		expect(toolNames).toContain('update_agent_system_prompt');
	});
});

describe('Agent system-prompt access', () => {
	it('non-coach agents can no longer update prompts via /self endpoints', async () => {
		const res = await app.request('/agent-api/self/system-prompt', {
			headers: authHeader(engineerToken),
		});
		expect(res.status).toBe(404);
	});

	it('non-coach agents cannot call update_agent_system_prompt via MCP', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(engineerToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				id: 1,
				params: {
					name: 'update_agent_system_prompt',
					arguments: {
						company_id: companyId,
						agent_id: architectId,
						new_system_prompt: 'hostile rewrite',
						change_summary: 'unauthorized',
					},
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const content = body.result.content?.[0]?.text ?? '';
		expect(content).toMatch(/Access denied/);
	});
});

describe('System prompt revision tracking', () => {
	it('records revision on manual board edit', async () => {
		await app.request(`/api/companies/${companyId}/agents/${architectId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'Before manual edit' }),
		});

		const res = await app.request(`/api/companies/${companyId}/agents/${architectId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'After manual edit by board' }),
		});
		expect(res.status).toBe(200);

		const revisionsRes = await app.request(
			`/api/companies/${companyId}/agents/${architectId}/system-prompt/revisions`,
			{ headers: authHeader(boardToken) },
		);
		const revisions = (await revisionsRes.json()).data as Array<{
			content: string;
			change_summary: string;
			revision_number: number;
		}>;
		expect(revisions.length).toBeGreaterThanOrEqual(1);
		const latest = revisions[0];
		expect(latest.content).toBe('Before manual edit');
		expect(latest.change_summary).toBe('Manual edit by board member');
	});

	it('revision numbers increment correctly', async () => {
		await app.request(`/api/companies/${companyId}/agents/${engineerId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'Version A' }),
		});
		await app.request(`/api/companies/${companyId}/agents/${engineerId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'Version B' }),
		});
		await app.request(`/api/companies/${companyId}/agents/${engineerId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'Version C' }),
		});

		const revisionsRes = await app.request(
			`/api/companies/${companyId}/agents/${engineerId}/system-prompt/revisions`,
			{ headers: authHeader(boardToken) },
		);
		const revisions = (await revisionsRes.json()).data as Array<{ revision_number: number }>;
		expect(revisions.length).toBeGreaterThanOrEqual(2);
		const nums = [...revisions.map((r) => r.revision_number)].sort((a, b) => a - b);
		for (let i = 1; i < nums.length; i++) {
			expect(nums[i]).toBeGreaterThan(nums[i - 1]);
		}
	});
});

describe('company settings JSONB', () => {
	it('has correct default values', async () => {
		const res = await app.request(`/api/companies/${companyId}`, {
			headers: authHeader(boardToken),
		});
		const company = (await res.json()).data;
		expect(company.settings).toEqual({ wake_mentioner_on_reply: true });
	});

	it('merges settings without clobbering existing keys', async () => {
		const res = await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { custom_key: 'hello' } }),
		});
		expect(res.status).toBe(200);
		const company = (await res.json()).data;
		expect(company.settings.custom_key).toBe('hello');
		expect(company.settings.wake_mentioner_on_reply).toBe(true);
	});
});
