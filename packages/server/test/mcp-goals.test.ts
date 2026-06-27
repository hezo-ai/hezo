import type { PGlite } from '@electric-sql/pglite';
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
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let captainAgentId: string;
let goalId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const teamRes = await createTestTeam(db, { name: 'MCP Goals Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'MCP Goals Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainAgentId = captain.rows[0].id;

	const goalRes = await app.request(`/api/projects/${projectSlug}/goals`, {
		method: 'POST',
		headers: { ...authHeader(token), 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'Grow MRR to $10k', check_frequency: 'daily' }),
	});
	goalId = (await goalRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function callTool(
	bearer: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text);
}

describe('MCP goals tools', () => {
	it('registers list_goals and update_goal_progress', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		const names = (await res.json()).result.tools.map((t: { name: string }) => t.name);
		expect(names).toContain('list_goals');
		expect(names).toContain('update_goal_progress');
	});

	it('list_goals returns the project goals', async () => {
		const goals = (await callTool(token, 'list_goals', { project: projectSlug })) as Array<{
			id: string;
		}>;
		expect(goals.map((g) => g.id)).toContain(goalId);
	});

	it('update_goal_progress is rejected for a non-run caller', async () => {
		const result = (await callTool(token, 'update_goal_progress', {
			project: projectSlug,
			goal_id: goalId,
			progress_percent: 20,
			health: 'on_track',
			status_blurb: 'Early days',
		})) as { error?: string };
		expect(result.error).toMatch(/within an agent run/);
	});

	it('update_goal_progress records progress from a Captain run', async () => {
		const agent = await mintAgentToken(db, masterKeyManager, captainAgentId, teamId, null, {
			projectId,
		});
		const updated = (await callTool(agent.token, 'update_goal_progress', {
			project: projectSlug,
			goal_id: goalId,
			progress_percent: 45,
			health: 'at_risk',
			status_blurb: 'Churn is up; need a retention push.',
		})) as { progress_percent: number; health: string; last_checked_at: string | null };
		expect(updated.progress_percent).toBe(45);
		expect(updated.health).toBe('at_risk');
		expect(updated.last_checked_at).not.toBeNull();

		// The snapshot is linked to the run, so it shows in the goal's history.
		const goals = (await callTool(token, 'list_goals', { project: projectSlug })) as Array<{
			id: string;
			history: Array<{ percent: number }>;
		}>;
		const goal = goals.find((g) => g.id === goalId);
		expect(goal?.history.at(-1)?.percent).toBe(45);
	});
});
