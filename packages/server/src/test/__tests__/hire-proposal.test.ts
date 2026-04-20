import type { PGlite } from '@electric-sql/pglite';
import { CEO_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let ceoId: string;
let engineerId: string;

async function callTool(
	agentToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
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
	return JSON.parse(body.result.content[0].text);
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
		body: JSON.stringify({ name: 'Hire Proposal Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data;
	ceoId = agents.find((a: Record<string, unknown>) => a.slug === CEO_AGENT_SLUG).id;
	engineerId = agents.find((a: Record<string, unknown>) => a.slug === 'engineer').id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('MCP tool update_hire_proposal', () => {
	it('lets the CEO revise a pending hire proposal', async () => {
		const onboardRes = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Support Lead',
				role_description: 'Runs customer support',
				system_prompt: 'Draft prompt.',
			}),
		});
		const { approval } = (await onboardRes.json()).data;

		const { token: ceoToken } = await mintAgentToken(db, masterKeyManager, ceoId, companyId);
		const result = (await callTool(ceoToken, 'update_hire_proposal', {
			approval_id: approval.id,
			system_prompt: 'You are the Support Lead. Own all customer support channels.',
			monthly_budget_cents: 4200,
		})) as { payload: Record<string, unknown> } | { error: string };

		expect('error' in result).toBe(false);
		expect((result as { payload: Record<string, unknown> }).payload.system_prompt).toContain(
			'Own all customer support channels',
		);
		expect((result as { payload: Record<string, unknown> }).payload.monthly_budget_cents).toBe(
			4200,
		);

		// Original slug/title are preserved unless explicitly overridden
		expect((result as { payload: Record<string, unknown> }).payload.slug).toBe('support-lead');
		expect((result as { payload: Record<string, unknown> }).payload.title).toBe('Support Lead');
	});

	it('rejects non-CEO agents', async () => {
		const onboardRes = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sales Lead', role_description: 'x' }),
		});
		const { approval } = (await onboardRes.json()).data;

		const { token: engToken } = await mintAgentToken(db, masterKeyManager, engineerId, companyId);
		const result = (await callTool(engToken, 'update_hire_proposal', {
			approval_id: approval.id,
			system_prompt: 'hostile rewrite',
		})) as { error?: string };

		expect(result.error).toBe('Only the CEO can revise hire proposals');
	});

	it('rejects revisions to resolved proposals', async () => {
		const onboardRes = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Ops Lead', role_description: 'x' }),
		});
		const { approval } = (await onboardRes.json()).data;

		await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied', resolution_note: 'no' }),
		});

		const { token: ceoToken } = await mintAgentToken(db, masterKeyManager, ceoId, companyId);
		const result = (await callTool(ceoToken, 'update_hire_proposal', {
			approval_id: approval.id,
			system_prompt: 'too late',
		})) as { error?: string };

		expect(result.error).toBe('Hire approval is already resolved');
	});
});
