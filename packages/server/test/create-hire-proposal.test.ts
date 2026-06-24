import type { PGlite } from '@electric-sql/pglite';
import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let projectSlug: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let internalProjectId: string;
let captainId: string;
let engineerId: string;

async function callTool(
	agentToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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

async function captainToken(): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, captainId, teamId, null, {
		projectId: internalProjectId,
	});
	return t;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Create Hire Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projData = (await (await createTestProject(db, teamId, { name: 'Setup Project' })).json())
		.data;
	projectSlug = projData.slug;
	internalProjectId = projData.id;

	const agents = (
		await (
			await app.request(`/api/projects/${projectSlug}/agents`, { headers: authHeader(token) })
		).json()
	).data;
	captainId = agents.find((a: Record<string, unknown>) => a.slug === CAPTAIN_AGENT_SLUG).id;
	engineerId = agents.find((a: Record<string, unknown>) => a.slug === 'engineer').id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('MCP tool create_hire_proposal', () => {
	it('lets the Captain file a pending hire proposal', async () => {
		const result = await callTool(await captainToken(), 'create_hire_proposal', {
			title: 'Data Scientist',
			role_description: 'Owns the analytics models',
			system_prompt: 'You are the Data Scientist. Build and maintain the models.',
			monthly_budget_cents: 5000,
		});

		expect(result.error).toBeUndefined();
		expect(result.status).toBe('pending');
		const payload = result.payload as Record<string, unknown>;
		expect(payload.title).toBe('Data Scientist');
		expect(payload.slug).toBe('data-scientist');
		expect(payload.monthly_budget_cents).toBe(5000);

		// It is a real pending hire approval on the team.
		const row = await db.query<{ type: string; status: string; team_id: string }>(
			'SELECT type, status, team_id FROM approvals WHERE id = $1',
			[result.approval_id],
		);
		expect(row.rows[0]).toMatchObject({ type: 'hire', status: 'pending', team_id: teamId });
	});

	it('links the proposal to an originating ticket', async () => {
		const taskRow = await db.query<{ id: string }>(
			'SELECT id FROM tasks WHERE team_id = $1 LIMIT 1',
			[teamId],
		);
		const taskId = taskRow.rows[0].id;

		const result = await callTool(await captainToken(), 'create_hire_proposal', {
			title: 'Support Engineer',
			system_prompt: 'You handle support escalations.',
			task_id: taskId,
		});
		expect(result.error).toBeUndefined();
		expect((result.payload as Record<string, unknown>).task_id).toBe(taskId);
	});

	it('rejects a task_id that is not on the team', async () => {
		const result = await callTool(await captainToken(), 'create_hire_proposal', {
			title: 'Stray Role',
			task_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(result.error).toBe('task_id not found on this team');
	});

	it('rejects non-Captain agents', async () => {
		const { token: engToken } = await mintAgentToken(
			db,
			masterKeyManager,
			engineerId,
			teamId,
			null,
			{ projectId: internalProjectId },
		);
		const result = await callTool(engToken, 'create_hire_proposal', {
			title: 'Rogue Role',
			system_prompt: 'unauthorized',
		});
		expect(result.error).toBe('Only the Captain can create hire proposals');
	});

	it('rejects a duplicate of an existing agent slug', async () => {
		const result = await callTool(await captainToken(), 'create_hire_proposal', {
			title: 'Captain',
		});
		expect(result.error).toContain('already exists');
	});

	it('materializes the agent when the admin approves the proposal', async () => {
		const proposal = await callTool(await captainToken(), 'create_hire_proposal', {
			title: 'Release Manager',
			role_description: 'Owns releases',
			system_prompt: 'You are the Release Manager.',
		});
		expect(proposal.error).toBeUndefined();

		const resolveRes = await app.request(`/api/approvals/${proposal.approval_id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(resolveRes.status).toBe(200);

		const agents = (
			await (
				await app.request(`/api/projects/${projectSlug}/agents`, { headers: authHeader(token) })
			).json()
		).data as Array<{ slug: string; admin_status: string }>;
		const created = agents.find((a) => a.slug === 'release-manager');
		expect(created).toBeDefined();
		expect(created?.admin_status).toBe('enabled');
	});
});
