import { ConnectorAccess } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { createOrFetchConnector } from '../src/services/connectors/lifecycle';
import { discoverConnectorMethods } from '../src/services/connectors/method-discovery';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';
import { startTestMcpHttpServer, type TestMcpServer } from './helpers/test-mcp-http-server';

/**
 * An agent can ask for a connector to be set up read-only. This covers the whole
 * chain: the tool argument, what lands on the row, what the human is shown
 * before authorizing, and what `list_connectors` tells a later run about the
 * methods it can't see.
 *
 * The rule the tests exist to pin down is that the request only ever *narrows*.
 * A stored `read` survives a re-register with `write`, and a human's own choice
 * always wins over a request that arrives afterwards.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let captainId: string;
let server: TestMcpServer;
let mcpUrl: string;

const TOOLS = [
	{ name: 'get_issue', description: 'Fetch an issue' },
	{ name: 'list_issues', description: 'List issues' },
	{ name: 'save_issue', description: 'Create or update an issue' },
	{ name: 'delete_issue', description: 'Delete an issue' },
];

/** Create a task in the test project and mint the Captain an agent token for it. */
async function taskWithAgentToken(prefix: string): Promise<{ taskId: string; agentToken: string }> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
		 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, $4 || '-' || (COALESCE(MAX(number), 0) + 1)::text, 'needs a connector'
		 FROM tasks WHERE project_id = $2
		 RETURNING id`,
		[teamId, projectId, captainId, prefix],
	);
	const taskId = r.rows[0].id;
	const { token: agentToken } = await mintAgentToken(
		db,
		masterKeyManager,
		captainId,
		teamId,
		taskId,
	);
	return { taskId, agentToken };
}

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
			id: 1,
			method: 'tools/call',
			params: { name, arguments: args },
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text);
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
	const teamData = (
		await (await createTestTeam(db, { name: 'Access Co', template_id: typeId })).json()
	).data;
	teamId = teamData.id;

	const setup = (await (await createTestProject(db, teamId, { name: 'Setup' })).json()).data;
	const agents = (
		await (
			await app.request(`/api/projects/${setup.slug}/agents`, { headers: authHeader(token) })
		).json()
	).data as Array<{ id: string; slug: string }>;
	captainId = agents.find((a) => a.slug === 'captain')!.id;

	const project = (await (await createTestProject(db, teamId, { name: 'Work' })).json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	server = await startTestMcpHttpServer({ tools: TOOLS });
	mcpUrl = `http://127.0.0.1:${server.port}/mcp`;
});

afterAll(async () => {
	await server.close();
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM mcp_connections');
});

describe('register_connector access argument', () => {
	it("records a read request on the row and on the human's connect card", async () => {
		const { taskId, agentToken } = await taskWithAgentToken('RDO');
		const payload = (await callTool(agentToken, 'register_connector', {
			project: projectId,
			task_id: taskId,
			display_name: 'Tracker',
			mcp_url: mcpUrl,
			access: 'read',
		})) as { connector_id: string; comment_id: string };

		const row = await db.query<{ requested_access: string | null }>(
			`SELECT requested_access::text AS requested_access FROM mcp_connections WHERE id = $1`,
			[payload.connector_id],
		);
		expect(row.rows[0].requested_access).toBe('read');

		const comment = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments WHERE id = $1`,
			[payload.comment_id],
		);
		expect(comment.rows[0].content.requested_access).toBe('read');
	});

	it("stores nothing for 'write', which is the default behaviour and not a decision", async () => {
		const { taskId, agentToken } = await taskWithAgentToken('WRT');
		const payload = (await callTool(agentToken, 'register_connector', {
			project: projectId,
			task_id: taskId,
			display_name: 'Tracker',
			mcp_url: mcpUrl,
			access: 'write',
		})) as { connector_id: string; comment_id: string };

		const row = await db.query<{ requested_access: string | null }>(
			`SELECT requested_access::text AS requested_access FROM mcp_connections WHERE id = $1`,
			[payload.connector_id],
		);
		expect(row.rows[0].requested_access).toBeNull();

		const comment = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments WHERE id = $1`,
			[payload.comment_id],
		);
		expect(comment.rows[0].content.requested_access).toBeUndefined();
	});

	it('omitting access behaves exactly as before', async () => {
		const { taskId, agentToken } = await taskWithAgentToken('OMT');
		const payload = (await callTool(agentToken, 'register_connector', {
			project: projectId,
			task_id: taskId,
			display_name: 'Tracker',
			mcp_url: mcpUrl,
		})) as { connector_id: string };

		const row = await db.query<{ requested_access: string | null }>(
			`SELECT requested_access::text AS requested_access FROM mcp_connections WHERE id = $1`,
			[payload.connector_id],
		);
		expect(row.rows[0].requested_access).toBeNull();
	});
});

describe('a request only ever narrows', () => {
	it("upgrades an existing unrestricted row to 'read' on re-register", async () => {
		const first = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
		});
		expect(first.row.requested_access).toBeNull();

		const second = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
			requestedAccess: ConnectorAccess.Read,
		});
		expect(second.alreadyExisted).toBe(true);
		expect(second.row.id).toBe(first.row.id);
		expect(second.row.requested_access).toBe('read');
	});

	it("never clears a stored 'read' when a later register asks for write", async () => {
		const first = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
			requestedAccess: ConnectorAccess.Read,
		});
		expect(first.row.requested_access).toBe('read');

		const second = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
			requestedAccess: null,
		});
		expect(second.row.requested_access).toBe('read');
	});

	it("does not record a request over an operator's own allowlist", async () => {
		const first = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
		});
		// The operator has already decided. A request arriving afterwards must not
		// disturb it — not even by being recorded for a later discovery to apply.
		await db.query(`UPDATE mcp_connections SET enabled_methods = $1::jsonb WHERE id = $2`, [
			JSON.stringify(['get_issue', 'save_issue']),
			first.row.id,
		]);

		const second = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
			requestedAccess: ConnectorAccess.Read,
		});
		expect(second.row.requested_access).toBeNull();

		const kept = await db.query<{ enabled_methods: string[] }>(
			`SELECT enabled_methods FROM mcp_connections WHERE id = $1`,
			[first.row.id],
		);
		expect(kept.rows[0].enabled_methods).toEqual(['get_issue', 'save_issue']);
	});

	it('survives a revoke and reconnect, so the restriction is not lost', async () => {
		const first = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
			requestedAccess: ConnectorAccess.Read,
		});
		await db.query(`UPDATE mcp_connections SET revoked_at = now() WHERE id = $1`, [first.row.id]);

		const again = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
		});
		expect(again.row.id).toBe(first.row.id);
		expect(again.row.revoked_at).toBeNull();
		expect(again.row.requested_access).toBe('read');
	});
});

describe('the request reaches discovery', () => {
	it('disables every write method the server advertises when the human connects', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
			requestedAccess: ConnectorAccess.Read,
		});
		await db.query(`UPDATE mcp_connections SET activated_at = now() WHERE id = $1`, [row.id]);

		const result = await discoverConnectorMethods({ db, masterKeyManager }, row.id, 'connect');
		expect(result.ok).toBe(true);

		const after = await db.query<{ enabled_methods: string[]; access_applied_at: string | null }>(
			`SELECT enabled_methods, access_applied_at::text AS access_applied_at
			 FROM mcp_connections WHERE id = $1`,
			[row.id],
		);
		expect(after.rows[0].enabled_methods.sort()).toEqual(['get_issue', 'list_issues']);
		expect(after.rows[0].access_applied_at).not.toBeNull();
	});

	it('resolves a vendor-namespaced catalog to its real read methods', async () => {
		// A server that names every tool after itself put the vendor where the verb
		// belongs, so the whole catalog classified as write and `access: 'read'`
		// resolved to an allowlist of nothing.
		const vendor = await startTestMcpHttpServer({
			tools: [
				{ name: 'typefully_list_drafts' },
				{ name: 'typefully_get_me' },
				{ name: 'typefully_create_draft' },
			],
		});
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'typefully',
				displayName: 'Typefully',
				mcpUrl: `http://127.0.0.1:${vendor.port}/mcp`,
				mcpTransport: 'http',
				projectId,
				requestedAccess: ConnectorAccess.Read,
			});
			await db.query(`UPDATE mcp_connections SET activated_at = now() WHERE id = $1`, [row.id]);

			const result = await discoverConnectorMethods({ db, masterKeyManager }, row.id, 'connect');
			expect(result.ok).toBe(true);

			const after = await db.query<{ enabled_methods: string[] }>(
				`SELECT enabled_methods FROM mcp_connections WHERE id = $1`,
				[row.id],
			);
			expect(after.rows[0].enabled_methods.sort()).toEqual([
				'typefully_get_me',
				'typefully_list_drafts',
			]);
		} finally {
			await vendor.close();
		}
	});

	it('warns about tool names that cross the provider limit without withholding them', async () => {
		// `mcp__<connector>__<tool>` has to fit in 64 characters. Past that the
		// provider decides what happens to the tool, so this is diagnosable rather
		// than silent - but it never costs the run the descriptor.
		const long = await startTestMcpHttpServer({
			tools: [
				{ name: 'typefully_linkedin_resolve_linkedin_organization_from_url' },
				{ name: 'typefully_get_me' },
			],
		});
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'typefully',
				displayName: 'Typefully',
				mcpUrl: `http://127.0.0.1:${long.port}/mcp`,
				mcpTransport: 'http',
				projectId,
			});
			await db.query(`UPDATE mcp_connections SET activated_at = now() WHERE id = $1`, [row.id]);

			const result = await discoverConnectorMethods({ db, masterKeyManager }, row.id, 'connect');
			expect(result.ok).toBe(true);

			// Both tools are still catalogued - the warning is advisory.
			const after = await db.query<{ discovered_methods: Array<{ name: string }> }>(
				`SELECT discovered_methods FROM mcp_connections WHERE id = $1`,
				[row.id],
			);
			expect(after.rows[0].discovered_methods.map((m) => m.name)).toEqual([
				'typefully_linkedin_resolve_linkedin_organization_from_url',
				'typefully_get_me',
			]);
		} finally {
			await long.close();
		}
	});

	it('leaves the connector unrestricted when no method classifies read-only', async () => {
		// An allowlist enabling nothing would withhold every tool while the card
		// still read Connected. NULL means unrestricted, `[]` means restricted to
		// nothing, and keeping that distinction honest is the whole point.
		const writeOnly = await startTestMcpHttpServer({
			tools: [{ name: 'tracker_create_issue' }, { name: 'tracker_delete_issue' }],
		});
		try {
			const { row } = await createOrFetchConnector(db, {
				name: 'tracker-write-only',
				displayName: 'Tracker',
				mcpUrl: `http://127.0.0.1:${writeOnly.port}/mcp`,
				mcpTransport: 'http',
				projectId,
				requestedAccess: ConnectorAccess.Read,
			});
			await db.query(`UPDATE mcp_connections SET activated_at = now() WHERE id = $1`, [row.id]);

			const result = await discoverConnectorMethods({ db, masterKeyManager }, row.id, 'connect');
			expect(result.ok).toBe(true);

			const after = await db.query<{
				enabled_methods: string[] | null;
				discovered_methods: unknown[] | null;
				access_applied_at: string | null;
			}>(
				`SELECT enabled_methods, discovered_methods, access_applied_at::text AS access_applied_at
				 FROM mcp_connections WHERE id = $1`,
				[row.id],
			);
			// The catalog is still cached - only the narrowing was withheld.
			expect(after.rows[0].discovered_methods).toHaveLength(2);
			expect(after.rows[0].enabled_methods).toBeNull();
			// The request stays pending, so a later refresh can still satisfy it.
			expect(after.rows[0].access_applied_at).toBeNull();
		} finally {
			await writeOnly.close();
		}
	});
});

describe('list_connectors method_access', () => {
	it('tells a run that the gap in its tool list is deliberate, and how wide', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
			requestedAccess: ConnectorAccess.Read,
		});
		await db.query(`UPDATE mcp_connections SET activated_at = now() WHERE id = $1`, [row.id]);
		await discoverConnectorMethods({ db, masterKeyManager }, row.id, 'connect');

		const { agentToken } = await taskWithAgentToken('LST');
		const rows = (
			(await callTool(agentToken, 'list_connectors', {
				project: projectSlug,
			})) as {
				items: Array<{
					name: string;
					method_access: {
						mode: string;
						enabled: number;
						total: number;
						disabled_write: number;
					} | null;
				}>;
			}
		).items;

		const tracker = rows.find((r) => r.name === 'tracker');
		expect(tracker?.method_access).toEqual({
			mode: 'restricted',
			enabled: 2,
			total: 4,
			disabled_write: 2,
		});
	});

	it('reports mode "all" for a listed connector nobody has restricted', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
		});
		await db.query(`UPDATE mcp_connections SET activated_at = now() WHERE id = $1`, [row.id]);
		await discoverConnectorMethods({ db, masterKeyManager }, row.id, 'connect');

		const { agentToken } = await taskWithAgentToken('ALL');
		const rows = (
			(await callTool(agentToken, 'list_connectors', {
				project: projectSlug,
			})) as {
				items: Array<{
					name: string;
					method_access: { mode: string; disabled_write: number } | null;
				}>;
			}
		).items;

		const tracker = rows.find((r) => r.name === 'tracker');
		expect(tracker?.method_access?.mode).toBe('all');
		expect(tracker?.method_access?.disabled_write).toBe(0);
	});

	it('is null for a connector whose methods have never been listed', async () => {
		await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
		});

		const { agentToken } = await taskWithAgentToken('NUL');
		const rows = (
			(await callTool(agentToken, 'list_connectors', {
				project: projectSlug,
			})) as { items: Array<{ name: string; method_access: unknown }> }
		).items;

		expect(rows.find((r) => r.name === 'tracker')?.method_access).toBeNull();
	});
});

/**
 * `tools_this_run` answers, from inside a run, how many of a connector's tools
 * that run actually received. The question it exists for is the one an agent
 * previously had to guess at: a connector reads Connected, its tools are not
 * where the agent expected them, and nothing could confirm or refute whether
 * they arrived. A guess written into a progress summary then outlived several
 * runs. This is the measurement instead.
 */
describe('list_connectors tools_this_run', () => {
	async function connectorAndRun(prefix: string): Promise<{ agentToken: string; runId: string }> {
		await createOrFetchConnector(db, {
			name: 'tracker',
			displayName: 'Tracker',
			mcpUrl,
			mcpTransport: 'http',
			projectId,
		});
		const r = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, $4 || '-' || (COALESCE(MAX(number), 0) + 1)::text, 'needs a connector'
			 FROM tasks WHERE project_id = $2
			 RETURNING id`,
			[teamId, projectId, captainId, prefix],
		);
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			r.rows[0]?.id,
		);
		return { agentToken, runId };
	}

	async function trackerToolsThisRun(agentToken: string): Promise<number | null | undefined> {
		const rows = (
			(await callTool(agentToken, 'list_connectors', { project: projectSlug })) as {
				items: Array<{ name: string; tools_this_run: number | null }>;
			}
		).items;
		return rows.find((r) => r.name === 'tracker')?.tools_this_run;
	}

	it("reports the count the run's runtime recorded for that connector", async () => {
		const { agentToken, runId } = await connectorAndRun('TTR');
		await db.query(`UPDATE heartbeat_runs SET mcp_tool_counts = $1::jsonb WHERE id = $2`, [
			JSON.stringify({ hezo: 82, tracker: 4 }),
			runId,
		]);
		expect(await trackerToolsThisRun(agentToken)).toBe(4);
	});

	it('reports 0 distinctly, since that is the actionable answer', async () => {
		// Connected and contributing nothing callable is a real fault worth
		// escalating; it must not read the same as "nobody measured it".
		const { agentToken, runId } = await connectorAndRun('TZR');
		await db.query(`UPDATE heartbeat_runs SET mcp_tool_counts = $1::jsonb WHERE id = $2`, [
			JSON.stringify({ hezo: 82, tracker: 0 }),
			runId,
		]);
		expect(await trackerToolsThisRun(agentToken)).toBe(0);
	});

	it('is null when the run recorded no counts at all', async () => {
		const { agentToken } = await connectorAndRun('TNR');
		expect(await trackerToolsThisRun(agentToken)).toBeNull();
	});

	it('is null for a connector the run recorded no entry for', async () => {
		// A connector added mid-run, or one the runtime never reported: absent from
		// the recorded object is "not measured", not zero.
		const { agentToken, runId } = await connectorAndRun('TMR');
		await db.query(`UPDATE heartbeat_runs SET mcp_tool_counts = $1::jsonb WHERE id = $2`, [
			JSON.stringify({ hezo: 82 }),
			runId,
		]);
		expect(await trackerToolsThisRun(agentToken)).toBeNull();
	});
});
