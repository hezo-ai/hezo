import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let otherCompanyId: string;
let agentAId: string;
let agentBId: string;
let agentASlug: string;
let foreignAgentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const makeCompany = async (name: string) => {
		const r = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name }),
		});
		return (await r.json()).data.id as string;
	};

	companyId = await makeCompany('Batch Prompt Co');
	otherCompanyId = await makeCompany('Other Co');

	const TEMPLATE = [
		'You are an employee of {{company_name}}.',
		'Your manager is {{reports_to}}.',
		'',
		'Team context:',
		'{{team_context}}',
	].join('\n');

	const makeAgent = async (cId: string, title: string) => {
		const r = await app.request(`/api/companies/${cId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title, system_prompt: TEMPLATE }),
		});
		return (await r.json()).data as { id: string; slug: string };
	};

	const a = await makeAgent(companyId, 'Worker A');
	agentAId = a.id;
	agentASlug = a.slug;

	const b = await makeAgent(companyId, 'Worker B');
	agentBId = b.id;

	foreignAgentId = (await makeAgent(otherCompanyId, 'Outsider')).id;
});

afterAll(async () => {
	await safeClose(db);
});

async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text);
}

describe('POST /companies/:companyId/agents/system-prompts/batch', () => {
	it('returns per-item results with placeholders substituted by default', async () => {
		const r = await app.request(`/api/companies/${companyId}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [{ agent_id: agentAId }, { agent_id: agentBId }],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(2);
		for (const row of body.data) {
			expect(row.ok).toBe(true);
			expect(row.mode).toBe('placeholders');
			expect(typeof row.system_prompt).toBe('string');
			expect(row.system_prompt).not.toContain('{{company_name}}');
			expect(row.system_prompt).toContain('Batch Prompt Co');
			expect(row.system_prompt).not.toContain('## Working Guidelines');
		}
	});

	it('supports per-item mode (raw, placeholders, preview)', async () => {
		const r = await app.request(`/api/companies/${companyId}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [
					{ agent_id: agentAId, mode: 'raw' },
					{ agent_id: agentAId, mode: 'placeholders' },
					{ agent_id: agentAId, mode: 'preview' },
				],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(3);

		const raw = body.data[0];
		const placeholders = body.data[1];
		const preview = body.data[2];

		expect(raw.mode).toBe('raw');
		expect(placeholders.mode).toBe('placeholders');
		expect(preview.mode).toBe('preview');

		expect(raw.system_prompt).toContain('{{company_name}}');
		expect(placeholders.system_prompt).not.toContain('{{company_name}}');
		expect(placeholders.system_prompt).not.toContain('## Working Guidelines');
		expect(preview.system_prompt).not.toContain('{{company_name}}');
		expect(preview.system_prompt).toContain('## Working Guidelines');
		expect(preview.system_prompt).toContain('## Teammates');
		expect(preview.system_prompt).not.toContain('## Run Context');
	});

	it('accepts agent slug as well as UUID', async () => {
		const r = await app.request(`/api/companies/${companyId}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [{ agent_id: agentASlug }] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data[0].ok).toBe(true);
		expect(body.data[0].agent_id).toBe(agentAId);
	});

	it('returns per-item NOT_FOUND for unknown agent without failing the batch', async () => {
		const r = await app.request(`/api/companies/${companyId}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [
					{ agent_id: agentAId },
					{ agent_id: 'no-such-agent-slug' },
					{ agent_id: foreignAgentId },
				],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(3);
		expect(body.data[0].ok).toBe(true);
		expect(body.data[1].ok).toBe(false);
		expect(body.data[1].error).toMatch(/not found/i);
		expect(body.data[2].ok).toBe(false);
		expect(body.data[2].error).toMatch(/not found/i);
	});

	it('rejects empty, non-array, and oversized item lists', async () => {
		const emptyRes = await app.request(`/api/companies/${companyId}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [] }),
		});
		expect(emptyRes.status).toBe(400);

		const nonArrayRes = await app.request(
			`/api/companies/${companyId}/agents/system-prompts/batch`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ items: 'nope' }),
			},
		);
		expect(nonArrayRes.status).toBe(400);

		const oversizedRes = await app.request(
			`/api/companies/${companyId}/agents/system-prompts/batch`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					items: Array.from({ length: 51 }, () => ({ agent_id: agentAId })),
				}),
			},
		);
		expect(oversizedRes.status).toBe(400);
	});

	it('enforces company scoping (cannot batch fetch another company)', async () => {
		const r = await app.request(`/api/companies/${otherCompanyId}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [{ agent_id: agentAId }] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data[0].ok).toBe(false);
		expect(body.data[0].error).toMatch(/not found/i);
	});
});

describe('MCP tool: get_agent_system_prompts', () => {
	it('returns per-item resolved prompts via MCP transport', async () => {
		const result = (await callMcpTool('get_agent_system_prompts', {
			company_id: companyId,
			items: [{ agent_id: agentAId, mode: 'preview' }, { agent_id: agentBId }],
		})) as Array<{
			ok: boolean;
			agent_id: string;
			mode?: string;
			system_prompt?: string;
			error?: string;
		}>;
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(2);
		expect(result[0].ok).toBe(true);
		expect(result[0].mode).toBe('preview');
		expect(result[0].system_prompt).toContain('## Teammates');
		expect(result[1].ok).toBe(true);
		expect(result[1].mode).toBe('placeholders');
	});

	it("returns per-item NOT_FOUND when an agent doesn't belong to the queried company", async () => {
		const result = (await callMcpTool('get_agent_system_prompts', {
			company_id: companyId,
			items: [{ agent_id: foreignAgentId }],
		})) as Array<{ ok: boolean; error?: string }>;
		expect(result).toHaveLength(1);
		expect(result[0].ok).toBe(false);
		expect(result[0].error).toMatch(/not found/i);
	});
});
