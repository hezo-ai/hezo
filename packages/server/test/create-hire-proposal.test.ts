import { CAPTAIN_AGENT_SLUG, DEFAULT_TEAM_ID } from '@hezo/shared';
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
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

let app: Hono<Env>;
let db: Db;
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

async function ceoToken(): Promise<string> {
	const ceoId = await instanceCeoId(db);
	const { token: t } = await mintAgentToken(db, masterKeyManager, ceoId, DEFAULT_TEAM_ID, null, {
		crossProject: true,
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
			system_prompt: compliantPrompt('You are the Data Scientist. Build and maintain the models.'),
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
			system_prompt: compliantPrompt('You handle support escalations.'),
			task_id: taskId,
		});
		expect(result.error).toBeUndefined();
		expect((result.payload as Record<string, unknown>).task_id).toBe(taskId);

		// The proposal is mirrored as a pending hire_proposal comment on the ticket.
		const comment = await db.query<{
			content: { kind: string; title: string };
			chosen_option: unknown;
		}>(
			`SELECT content, chosen_option FROM task_comments
			 WHERE task_id = $1 AND content_type = 'action'::comment_content_type
			   AND content->>'kind' = 'hire_proposal' AND content->>'approval_id' = $2`,
			[taskId, result.approval_id],
		);
		expect(comment.rows).toHaveLength(1);
		expect(comment.rows[0].content.title).toBe('Support Engineer');
		expect(comment.rows[0].chosen_option).toBeNull();
	});

	it('links the proposal to an originating ticket by human-readable identifier', async () => {
		const taskRow = await db.query<{ id: string; identifier: string }>(
			'SELECT id, identifier FROM tasks WHERE team_id = $1 LIMIT 1',
			[teamId],
		);
		const { id: taskId, identifier } = taskRow.rows[0];
		// Sanity: the identifier is the human-readable form, not the UUID.
		expect(identifier).not.toBe(taskId);

		const result = await callTool(await captainToken(), 'create_hire_proposal', {
			title: 'Field Engineer',
			system_prompt: compliantPrompt('You handle on-site work.'),
			task_id: identifier,
		});
		expect(result.error).toBeUndefined();
		// The proposal stores the resolved UUID, not the identifier it was given.
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
		expect(result.error).toBe('Only the Captain or CEO can create hire proposals');
	});

	it('lets the CEO file a proposal for any team via project', async () => {
		const result = await callTool(await ceoToken(), 'create_hire_proposal', {
			project: projectSlug,
			title: 'Growth Lead',
			system_prompt: compliantPrompt('You drive growth experiments.'),
		});
		expect(result.error).toBeUndefined();
		const row = await db.query<{ team_id: string }>('SELECT team_id FROM approvals WHERE id = $1', [
			result.approval_id,
		]);
		expect(row.rows[0].team_id).toBe(teamId);
	});

	it('lets the CEO file a proposal for HQ', async () => {
		const hq = await db.query<{ slug: string }>(
			'SELECT slug FROM projects WHERE team_id = $1 AND is_internal = true LIMIT 1',
			[DEFAULT_TEAM_ID],
		);
		const result = await callTool(await ceoToken(), 'create_hire_proposal', {
			project: hq.rows[0].slug,
			title: 'HQ Ops Analyst',
			system_prompt: compliantPrompt('You support instance-wide operations.'),
		});
		expect(result.error).toBeUndefined();
		const row = await db.query<{ team_id: string }>('SELECT team_id FROM approvals WHERE id = $1', [
			result.approval_id,
		]);
		expect(row.rows[0].team_id).toBe(DEFAULT_TEAM_ID);
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
			system_prompt: compliantPrompt('You are the Release Manager.'),
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
