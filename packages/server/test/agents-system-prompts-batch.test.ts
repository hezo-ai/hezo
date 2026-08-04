import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let otherProjectSlug: string;
let agentAId: string;
let agentBId: string;
let agentASlug: string;
let foreignAgentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const makeTeam = async (name: string) => {
		const r = await createTestTeam(db, { name });
		return (await r.json()).data as { id: string; slug: string };
	};

	const team = await makeTeam('Batch Prompt Co');
	projectSlug = `${await projectSlugFor(db, team.id)}`;
	const otherTeam = await makeTeam('Other Co');
	otherProjectSlug = `${await projectSlugFor(db, otherTeam.id)}`;

	const TEMPLATE = [
		'You are an employee of {{team_name}}.',
		'Your manager is {{reports_to}}.',
		'',
		'Team context:',
		'{{team_context}}',
		'',
		// Required substitution vars (enforced by the authoring surfaces).
		'{{skills_context}}',
		'{{project_docs_context}}',
		'{{team_preferences_context}}',
	].join('\n');

	const makeAgent = async (pSlug: string, title: string) => {
		const r = await app.request(`/api/projects/${pSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title, system_prompt: TEMPLATE }),
		});
		return (await r.json()).data as { id: string; slug: string };
	};

	const a = await makeAgent(projectSlug, 'Worker A');
	agentAId = a.id;
	agentASlug = a.slug;

	const b = await makeAgent(projectSlug, 'Worker B');
	agentBId = b.id;

	foreignAgentId = (await makeAgent(otherProjectSlug, 'Outsider')).id;
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

describe('POST /teams/:teamId/agents/system-prompts/batch', () => {
	it('returns per-item results with placeholders substituted by default', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/agents/system-prompts/batch`, {
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
			expect(row.system_prompt).not.toContain('{{team_name}}');
			expect(row.system_prompt).toContain('Batch Prompt Co');
			expect(row.system_prompt).not.toContain('## Working Guidelines');
		}
	});

	it('supports per-item mode (raw, placeholders, preview)', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/agents/system-prompts/batch`, {
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

		expect(raw.system_prompt).toContain('{{team_name}}');
		expect(placeholders.system_prompt).not.toContain('{{team_name}}');
		expect(placeholders.system_prompt).not.toContain('## Working Guidelines');
		expect(preview.system_prompt).not.toContain('{{team_name}}');
		expect(preview.system_prompt).toContain('## Working Guidelines');
		expect(preview.system_prompt).toContain('## Teammates');
		expect(preview.system_prompt).not.toContain('## Run Context');
	});

	it('accepts agent slug as well as UUID', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/agents/system-prompts/batch`, {
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
		const r = await app.request(`/api/projects/${projectSlug}/agents/system-prompts/batch`, {
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
		const emptyRes = await app.request(`/api/projects/${projectSlug}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: [] }),
		});
		expect(emptyRes.status).toBe(400);

		const nonArrayRes = await app.request(
			`/api/projects/${projectSlug}/agents/system-prompts/batch`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ items: 'nope' }),
			},
		);
		expect(nonArrayRes.status).toBe(400);

		const oversizedRes = await app.request(
			`/api/projects/${projectSlug}/agents/system-prompts/batch`,
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

	it('enforces team scoping (cannot batch fetch another team)', async () => {
		const r = await app.request(`/api/projects/${otherProjectSlug}/agents/system-prompts/batch`, {
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
	// The MCP transport caps one tool result (`result_too_large`), and a
	// `preview`-mode prompt carries the full resolver output (role doc +
	// Working Guidelines + runtime blocks), so a batch of them can exceed it.
	// The tool therefore pages: it returns the prompts that fit plus a
	// `next_index` to resume from, rather than rejecting the call and pushing
	// the caller into one request per agent.
	type PromptPage = {
		items: Array<{
			ok: boolean;
			agent_id: string;
			mode?: string;
			system_prompt?: string;
			error?: string;
		}>;
		start_index: number;
		returned: number;
		total: number;
		next_index: number | null;
	};

	it('returns per-item resolved prompts via MCP transport', async () => {
		const page = (await callMcpTool('get_agent_system_prompts', {
			project: projectSlug,
			items: [{ agent_id: agentAId }, { agent_id: agentBId }],
		})) as PromptPage;
		expect(page.items).toHaveLength(2);
		expect(page.total).toBe(2);
		expect(page.next_index).toBeNull();
		expect(page.items[0].ok).toBe(true);
		expect(page.items[0].mode).toBe('placeholders');
		expect(page.items[1].ok).toBe(true);
		expect(page.items[1].mode).toBe('placeholders');
	});

	it('resolves a preview prompt via MCP transport (single item)', async () => {
		const page = (await callMcpTool('get_agent_system_prompts', {
			project: projectSlug,
			items: [{ agent_id: agentAId, mode: 'preview' }],
		})) as PromptPage;
		expect(page.items).toHaveLength(1);
		expect(page.items[0].ok).toBe(true);
		expect(page.items[0].mode).toBe('preview');
		expect(page.items[0].system_prompt).toContain('## Teammates');
	});

	it('batches previews in one call instead of forcing one request per agent', async () => {
		const page = (await callMcpTool('get_agent_system_prompts', {
			project: projectSlug,
			items: [
				{ agent_id: agentAId, mode: 'preview' },
				{ agent_id: agentBId, mode: 'preview' },
			],
		})) as PromptPage & { error?: string };
		// The regression guard: this call used to come back result_too_large.
		expect(page.error).toBeUndefined();
		expect(page.total).toBe(2);
		expect(page.items.length).toBeGreaterThan(0);
		expect(page.items[0].ok).toBe(true);
	});

	it("returns per-item NOT_FOUND when an agent doesn't belong to the queried team", async () => {
		const page = (await callMcpTool('get_agent_system_prompts', {
			project: projectSlug,
			items: [{ agent_id: foreignAgentId }],
		})) as PromptPage;
		expect(page.items).toHaveLength(1);
		expect(page.items[0].ok).toBe(false);
		expect(page.items[0].error).toMatch(/not found/i);
	});
});
