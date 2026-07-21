import { CAPTAIN_AGENT_SLUG, REQUIRED_SYSTEM_PROMPT_VARS } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCoachId,
	mintAgentToken,
} from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

// A prompt with prose but no required substitution variables.
const NON_COMPLIANT = 'You are an agent. Do good work.';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let projectId: string;
let captainId: string;
let architectId: string;

async function mcp(agentToken: string, name: string, args: Record<string, unknown>) {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 1,
			params: { name, arguments: args },
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Var Enforcement Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const proj = (await (await createTestProject(db, teamId, { name: 'Setup' })).json()).data;
	projectSlug = proj.slug;
	projectId = proj.id;

	const agents = (
		await (
			await app.request(`/api/projects/${projectSlug}/agents`, { headers: authHeader(token) })
		).json()
	).data;
	captainId = agents.find((a: Record<string, unknown>) => a.slug === CAPTAIN_AGENT_SLUG).id;
	architectId = agents.find((a: Record<string, unknown>) => a.slug === 'architect').id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('required system-prompt vars are enforced across authoring surfaces', () => {
	it('onboard rejects a prompt missing required vars, lists them, and accepts a compliant one', async () => {
		const bad = await app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Analyst One', system_prompt: NON_COMPLIANT }),
		});
		expect(bad.status).toBe(400);
		const msg = (await bad.json()).error.message as string;
		for (const v of REQUIRED_SYSTEM_PROMPT_VARS) expect(msg).toContain(v);

		const good = await app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Analyst One', system_prompt: compliantPrompt('Analyst.') }),
		});
		expect(good.status).toBe(201);
	});

	it('direct agent create rejects a non-compliant prompt', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Direct Worker', system_prompt: NON_COMPLIANT }),
		});
		expect(res.status).toBe(400);
	});

	it('onboard still allows omitting the prompt entirely (backward compatible)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'No Prompt Worker', role_description: 'x' }),
		});
		expect(res.status).toBe(201);
	});

	it('PATCH /approvals rejects a revised prompt missing required vars', async () => {
		const created = await app.request(`/api/projects/${projectSlug}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'hire',
				payload: { title: 'Pending Role', slug: 'pending-role' },
			}),
		});
		const approval = (await created.json()).data;
		const res = await app.request(`/api/approvals/${approval.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: NON_COMPLIANT }),
		});
		expect(res.status).toBe(400);
	});

	it('PATCH /agents rejects a non-compliant prompt for a worker agent', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/${architectId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: NON_COMPLIANT }),
		});
		expect(res.status).toBe(400);
	});

	it('the MCP update_agent_system_prompt rejects a non-compliant prompt for a worker', async () => {
		const { token: captainToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			null,
			{
				projectId,
			},
		);
		const result = await mcp(captainToken, 'update_agent_system_prompt', {
			project: projectSlug,
			agent_id: architectId,
			new_system_prompt: NON_COMPLIANT,
			change_summary: 'should be rejected',
		});
		expect(typeof result.error).toBe('string');
		expect(result.error as string).toContain('{{team_name}}');
	});

	it('instance singletons (the Coach) are exempt — a prompt without {{reports_to}} is accepted', async () => {
		// The Coach lives in HQ; edit it through the HQ project as the admin.
		const hq = await db.query<{ slug: string }>(
			'SELECT slug FROM projects WHERE is_internal = true LIMIT 1',
		);
		const coachId = await instanceCoachId(db);
		const res = await app.request(`/api/projects/${hq.rows[0].slug}/agents/${coachId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'You are the Coach. {{skills_context}}' }),
		});
		expect(res.status).toBe(200);
	});
});
