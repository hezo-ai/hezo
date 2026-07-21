import { CAPTAIN_AGENT_SLUG, DEFAULT_TEAM_ID, HQ_PROJECT_SLUG } from '@hezo/shared';
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

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let projectId: string;

interface ToolResult {
	error?: string;
	updated?: boolean;
	admin_status?: string;
	slug?: string;
}

async function callTool(
	agentToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
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
	return JSON.parse(body.result.content[0].text) as ToolResult;
}

async function agentIdBySlug(slug: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	return r.rows[0].id;
}

async function adminStatusOf(slug: string): Promise<string> {
	const r = await db.query<{ admin_status: string }>(
		`SELECT ma.admin_status FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	return r.rows[0].admin_status;
}

async function ceoToken(): Promise<string> {
	const ceoId = await instanceCeoId(db);
	const { token: t } = await mintAgentToken(db, masterKeyManager, ceoId, teamId, null, {
		projectId,
	});
	return t;
}

/**
 * Mints a CEO token scoped to HQ but acting cross-project on the target team's
 * project — mirroring the live CEO chat session, whose run is scoped to HQ
 * (`crossProject`) rather than the team it reaches into. Exercises the
 * isHqInstanceAgent authorization path rather than the in-team canCoordinateTeam one.
 */
async function ceoChatToken(): Promise<string> {
	const ceoId = await instanceCeoId(db);
	const { token: t } = await mintAgentToken(db, masterKeyManager, ceoId, DEFAULT_TEAM_ID, null, {
		projectId,
		crossProject: true,
	});
	return t;
}

async function insertTaskAssignedTo(assigneeSlug: string, title: string): Promise<string> {
	const assigneeId = await agentIdBySlug(assigneeSlug);
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
	);
	return res.rows[0].id;
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

	const teamRes = await createTestTeam(db, { name: 'Retire Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const proj = (await (await createTestProject(db, teamId, { name: 'Setup Project' })).json()).data;
	projectSlug = proj.slug;
	projectId = proj.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('MCP tool set_agent_status', () => {
	it('lets the CEO retire an agent cross-team and unassigns its open tasks', async () => {
		const taskId = await insertTaskAssignedTo('researcher', 'Research the market');

		const result = await callTool(await ceoToken(), 'set_agent_status', {
			project: projectSlug,
			agent: 'researcher',
			status: 'disabled',
		});

		expect(result.error).toBeUndefined();
		expect(result.updated).toBe(true);
		expect(result.admin_status).toBe('disabled');
		expect(await adminStatusOf('researcher')).toBe('disabled');

		// The agent's open task is unassigned so nothing stalls on a retired agent.
		const task = await db.query<{ assignee_id: string | null }>(
			'SELECT assignee_id FROM tasks WHERE id = $1',
			[taskId],
		);
		expect(task.rows[0].assignee_id).toBeNull();
	});

	it('lets the CEO retire an agent from the cross-team chat session (scoped to HQ)', async () => {
		const result = await callTool(await ceoChatToken(), 'set_agent_status', {
			project: projectSlug,
			agent: 'product-lead',
			status: 'disabled',
		});
		expect(result.error).toBeUndefined();
		expect(result.updated).toBe(true);
		expect(await adminStatusOf('product-lead')).toBe('disabled');
	});

	it('lets the CEO reinstate a retired agent', async () => {
		const ceo = await ceoToken();
		const disable = await callTool(ceo, 'set_agent_status', {
			project: projectSlug,
			agent: 'qa-engineer',
			status: 'disabled',
		});
		expect(disable.error).toBeUndefined();
		expect(await adminStatusOf('qa-engineer')).toBe('disabled');

		const enable = await callTool(ceo, 'set_agent_status', {
			project: projectSlug,
			agent: 'qa-engineer',
			status: 'enabled',
		});
		expect(enable.error).toBeUndefined();
		expect(enable.admin_status).toBe('enabled');
		expect(await adminStatusOf('qa-engineer')).toBe('enabled');
	});

	it('lets the team Captain retire an agent', async () => {
		const captainId = await agentIdBySlug(CAPTAIN_AGENT_SLUG);
		const { token: captainToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			null,
			{ projectId },
		);
		const result = await callTool(captainToken, 'set_agent_status', {
			project: projectSlug,
			agent: 'ui-designer',
			status: 'disabled',
		});
		expect(result.error).toBeUndefined();
		expect(await adminStatusOf('ui-designer')).toBe('disabled');
	});

	it('rejects a non-coordinator agent', async () => {
		const engineerId = await agentIdBySlug('engineer');
		const { token: engToken } = await mintAgentToken(
			db,
			masterKeyManager,
			engineerId,
			teamId,
			null,
			{
				projectId,
			},
		);
		const result = await callTool(engToken, 'set_agent_status', {
			project: projectSlug,
			agent: 'architect',
			status: 'disabled',
		});
		expect(result.error).toContain('Access denied');
		expect(await adminStatusOf('architect')).toBe('enabled');
	});

	it('refuses to retire the Captain (protected role)', async () => {
		const result = await callTool(await ceoToken(), 'set_agent_status', {
			project: projectSlug,
			agent: CAPTAIN_AGENT_SLUG,
			status: 'disabled',
		});
		expect(result.error).toContain('cannot be retired');
		expect(await adminStatusOf(CAPTAIN_AGENT_SLUG)).toBe('enabled');
	});

	it.each([
		'ceo',
		'coach',
	])('refuses to disable the HQ instance %s (essential singleton)', async (slug) => {
		const result = await callTool(await ceoChatToken(), 'set_agent_status', {
			project: HQ_PROJECT_SLUG,
			agent: slug,
			status: 'disabled',
		});
		expect(result.error).toContain('essential to the instance');
		const r = await db.query<{ admin_status: string }>(
			`SELECT ma.admin_status FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = $2`,
			[DEFAULT_TEAM_ID, slug],
		);
		expect(r.rows[0].admin_status).toBe('enabled');
	});

	it('errors when the agent is already in the requested state', async () => {
		const ceo = await ceoToken();
		const first = await callTool(ceo, 'set_agent_status', {
			project: projectSlug,
			agent: 'security-engineer',
			status: 'disabled',
		});
		expect(first.error).toBeUndefined();

		const second = await callTool(ceo, 'set_agent_status', {
			project: projectSlug,
			agent: 'security-engineer',
			status: 'disabled',
		});
		expect(second.error).toBe('Agent is already disabled');
	});

	it('errors for an unknown agent', async () => {
		const result = await callTool(await ceoToken(), 'set_agent_status', {
			project: projectSlug,
			agent: 'no-such-agent',
			status: 'disabled',
		});
		expect(result.error).toContain('Agent not found in this team');
	});
});
