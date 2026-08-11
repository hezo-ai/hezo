import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { audienceOf, getToolDefs } from '../src/mcp/server';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';

/**
 * `tools/list` is projected per caller: a worker agent should not carry the
 * schemas of `create_team` or the Captain-only prompt editors it could never
 * call.
 *
 * The rule these pin down is that projection **hides, never forbids**. Every
 * gate still runs on `tools/call`, so a tool missing from a caller's list is a
 * context saving, not an access decision - which is why the last test calls a
 * hidden tool and asserts it is refused by the handler rather than by absence.
 */

let app: Hono<Env>;
let db: Db;
let adminToken: string;
let masterKeyManager: MasterKeyManager;
let captainToken: string;
let workerToken: string;
let ceoToken: string;

async function listToolNames(token: string): Promise<string[]> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
	return body.result.tools.map((t) => t.name);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;
	const team = (
		await (await createTestTeam(db, { name: 'Visibility Co', template_id: typeId })).json()
	).data;

	const project = (await (await createTestProject(db, team.id, { name: 'Work' })).json()).data;
	const agents = (
		await (
			await app.request(`/api/projects/${project.slug}/agents`, { headers: authHeader(adminToken) })
		).json()
	).data as Array<{ id: string; slug: string }>;

	const captainId = agents.find((a) => a.slug === CAPTAIN_AGENT_SLUG)!.id;
	const workerId = agents.find((a) => a.slug !== CAPTAIN_AGENT_SLUG)!.id;
	captainToken = (await mintAgentToken(db, masterKeyManager, captainId, team.id)).token;
	workerToken = (await mintAgentToken(db, masterKeyManager, workerId, team.id)).token;
	ceoToken = (
		await mintAgentToken(db, masterKeyManager, await instanceCeoId(db), team.id, null, {
			crossProject: true,
		})
	).token;
});

afterAll(async () => {
	await safeClose(db);
});

describe('audience declarations', () => {
	// There is deliberately no "every declared audience names a registered tool"
	// test here. The audience is declared *on* the registration, so naming a tool
	// that does not exist is not a drift a test has to catch - it is a call that
	// cannot be written. That is the whole reason the side table went away.

	it('leaves the great majority of the registry unrestricted', () => {
		// Most tools are gated only by project scope, so filtering is a trim, not a
		// redesign. If this ratio moves sharply, the audiences have drifted into
		// describing scope rather than caller class.
		const restricted = getToolDefs().filter((t) => t.audience !== undefined);
		expect(restricted.length).toBeLessThan(getToolDefs().length / 2);
		// And it is not vacuous: the projection has something to act on.
		expect(restricted.length).toBeGreaterThan(20);
	});

	it('resolves an audience off the registry, and undefined for an unknown name', () => {
		expect(audienceOf('create_team')).toBe('admin_superuser');
		expect(audienceOf('list_tasks')).toBeUndefined();
		expect(audienceOf('no_such_tool')).toBeUndefined();
	});
});

describe('tools/list projection', () => {
	it('strips the inert $schema key from every listed tool', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(captainToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		});
		const body = (await res.json()) as {
			result: { tools: Array<{ name: string; inputSchema?: Record<string, unknown> }> };
		};
		const withSchema = body.result.tools.filter((t) => t.inputSchema && '$schema' in t.inputSchema);
		expect(withSchema.map((t) => t.name)).toEqual([]);
		// The schemas themselves are untouched otherwise.
		const listTasks = body.result.tools.find((t) => t.name === 'list_tasks');
		expect(listTasks?.inputSchema).toBeDefined();
		expect(listTasks?.inputSchema?.type).toBe('object');
	});

	it('gives a worker agent the everyday tools without the roster and instance surface', async () => {
		const names = await listToolNames(workerToken);
		expect(names).toContain('list_tasks');
		expect(names).toContain('create_comment');
		expect(names).toContain('report_no_work');
		// Superuser, CEO, and Captain surfaces all withheld.
		expect(names).not.toContain('create_team');
		expect(names).not.toContain('create_project');
		expect(names).not.toContain('update_hire_proposal');
		expect(names).not.toContain('set_agent_name');
		expect(names).not.toContain('apply_marketplace_team');
	});

	it('gives a Captain its coordination surface but not the CEO-only tools', async () => {
		const names = await listToolNames(captainToken);
		expect(names).toContain('update_hire_proposal');
		expect(names).toContain('create_hire_proposal');
		expect(names).toContain('suggest_goal');
		expect(names).toContain('set_agent_name');
		expect(names).toContain('update_agent_system_prompt');
		expect(names).not.toContain('create_project');
		expect(names).not.toContain('start_team_setup');
		expect(names).not.toContain('create_team');
	});

	it('gives the CEO the project-creation surface', async () => {
		const names = await listToolNames(ceoToken);
		expect(names).toContain('create_project');
		expect(names).toContain('start_team_setup');
		expect(names).toContain('apply_marketplace_team');
		expect(names).toContain('suggest_goal');
		// An HQ agent coordinates in the team it is scoped into.
		expect(names).toContain('set_agent_reports_to');
	});

	it('gives a board superuser the instance tools and none of the agent-only ones', async () => {
		const names = await listToolNames(adminToken);
		expect(names).toContain('create_team');
		expect(names).toContain('get_agent_system_prompt');
		// `ceo_if_agent` constrains agents only - the handler lets an admin through.
		expect(names).toContain('apply_marketplace_team');
		// Agent-identity tools have no meaning for a board user.
		expect(names).not.toContain('report_no_work');
		expect(names).not.toContain('update_chat_memory');
		expect(names).not.toContain('update_project_progress');
	});

	it('hides without forbidding: the handler still refuses a withheld tool', async () => {
		// The whole point of the split. If projection were the access decision, a
		// caller that guessed the name would walk straight in.
		expect(await listToolNames(workerToken)).not.toContain('create_team');
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(workerToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'create_team', arguments: { name: 'Sneaky' } },
			}),
		});
		const body = (await res.json()) as {
			result?: { content: Array<{ text: string }> };
			error?: unknown;
		};
		// Either the SDK rejects it or the handler does; what must not happen is a
		// team getting created.
		const text = body.result?.content?.[0]?.text ?? JSON.stringify(body.error ?? {});
		expect(text.toLowerCase()).toMatch(/superuser|unauthorized|not allowed|invalid/);
		const created = await db.query('SELECT 1 FROM teams WHERE name = $1', ['Sneaky']);
		expect(created.rows).toHaveLength(0);
	});
});
