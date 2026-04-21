import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
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
			issue_prefix: 'CTC',
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
		expect(coach.system_prompt).toBeTruthy();
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

describe('MCP tools registration', () => {
	it('registers get_agent_system_prompt and propose_system_prompt_update tools', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('get_agent_system_prompt');
		expect(toolNames).toContain('propose_system_prompt_update');
	});
});

describe('Agent self system-prompt endpoints', () => {
	it('agent can read its own system prompt', async () => {
		const res = await app.request('/agent-api/self/system-prompt', {
			headers: authHeader(engineerToken),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.system_prompt).toBeTruthy();
	});

	it('agent can request system prompt update (creates approval)', async () => {
		const res = await app.request('/agent-api/self/system-prompt', {
			method: 'PATCH',
			headers: { ...authHeader(engineerToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				system_prompt: 'Updated prompt with learned rules',
				reason: 'Added rule about test coverage',
			}),
		});
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body.data.approval_id).toBeTruthy();
		expect(body.data.status).toBe('pending');
	});
});

describe('System prompt revision tracking', () => {
	it('records revision when approval is approved', async () => {
		await db.query('UPDATE member_agents SET system_prompt = $1 WHERE id = $2', [
			'Original prompt for revision test',
			architectId,
		]);

		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			companyId,
		);
		const patchRes = await app.request('/agent-api/self/system-prompt', {
			method: 'PATCH',
			headers: { ...authHeader(architectToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				system_prompt: 'Revised prompt via approval',
				reason: 'Self-improvement after feedback',
			}),
		});
		expect(patchRes.status).toBe(202);
		const approvalId = (await patchRes.json()).data.approval_id;

		const resolveRes = await app.request(`/api/approvals/${approvalId}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(resolveRes.status).toBe(200);

		const revisions = await db.query<{
			old_prompt: string;
			new_prompt: string;
			change_summary: string;
			approval_id: string;
		}>(
			'SELECT old_prompt, new_prompt, change_summary, approval_id FROM system_prompt_revisions WHERE member_agent_id = $1 ORDER BY revision_number DESC LIMIT 1',
			[architectId],
		);
		expect(revisions.rows.length).toBeGreaterThanOrEqual(1);
		expect(revisions.rows[0].old_prompt).toBe('Original prompt for revision test');
		expect(revisions.rows[0].new_prompt).toBe('Revised prompt via approval');
		expect(revisions.rows[0].approval_id).toBe(approvalId);
	});

	it('records revision on manual board edit', async () => {
		await db.query('UPDATE member_agents SET system_prompt = $1 WHERE id = $2', [
			'Before manual edit',
			architectId,
		]);

		const res = await app.request(`/api/companies/${companyId}/agents/${architectId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'After manual edit by board' }),
		});
		expect(res.status).toBe(200);

		const revisions = await db.query<{
			old_prompt: string;
			new_prompt: string;
			change_summary: string;
		}>(
			'SELECT old_prompt, new_prompt, change_summary FROM system_prompt_revisions WHERE member_agent_id = $1 ORDER BY revision_number DESC LIMIT 1',
			[architectId],
		);
		expect(revisions.rows.length).toBeGreaterThanOrEqual(1);
		expect(revisions.rows[0].old_prompt).toBe('Before manual edit');
		expect(revisions.rows[0].new_prompt).toBe('After manual edit by board');
		expect(revisions.rows[0].change_summary).toBe('Manual edit by board member');
	});

	it('revision numbers increment correctly', async () => {
		// Do two consecutive edits
		await db.query('UPDATE member_agents SET system_prompt = $1 WHERE id = $2', [
			'Version A',
			engineerId,
		]);
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

		const revisions = await db.query<{ revision_number: number; new_prompt: string }>(
			'SELECT revision_number, new_prompt FROM system_prompt_revisions WHERE member_agent_id = $1 ORDER BY revision_number ASC',
			[engineerId],
		);
		expect(revisions.rows.length).toBeGreaterThanOrEqual(2);
		const nums = revisions.rows.map((r) => r.revision_number);
		// Each revision number should be greater than the previous
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
		expect(company.settings).toEqual({ coach_auto_apply: false });
	});

	it('can update coach_auto_apply via settings PATCH', async () => {
		const res = await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { coach_auto_apply: true } }),
		});
		expect(res.status).toBe(200);
		const company = (await res.json()).data;
		expect(company.settings.coach_auto_apply).toBe(true);

		await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { coach_auto_apply: false } }),
		});
	});

	it('merges settings without clobbering existing keys', async () => {
		await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { coach_auto_apply: true } }),
		});

		const res = await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { custom_key: 'hello' } }),
		});
		expect(res.status).toBe(200);
		const company = (await res.json()).data;
		expect(company.settings.coach_auto_apply).toBe(true);
		expect(company.settings.custom_key).toBe('hello');

		await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { coach_auto_apply: false } }),
		});
	});

	it('preserves settings when patching other fields', async () => {
		await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { coach_auto_apply: true } }),
		});

		const res = await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'updated desc' }),
		});
		expect(res.status).toBe(200);
		const company = (await res.json()).data;
		expect(company.settings.coach_auto_apply).toBe(true);

		await app.request(`/api/companies/${companyId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { coach_auto_apply: false } }),
		});
	});
});
