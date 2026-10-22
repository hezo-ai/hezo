import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { callMcpTool } from './helpers/mcp-call';

/**
 * The agent-facing tools that make the server fetch a URL the agent named. On a
 * provisioned box `http://169.254.169.254/metadata/v1/user-data` returns the
 * boot document and every credential in it, and a skill or connector probe
 * hands the reply straight back to the agent. Each tool must refuse a private,
 * loopback or link-local target with the operator switch off, which is the
 * default and the hosted posture. No `allowPrivateEgressTargets()` here: the
 * guard is the subject.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let stub: Server;
let stubUrl: string;
let stubHits = 0;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	const teamId = (await (await createTestTeam(db, { name: 'Fetch Guard Co' })).json()).data.id;
	projectSlug = (await (await createTestProject(db, teamId, { name: 'Fetch Guard' })).json()).data
		.slug;

	// A server that would answer every probe, so a refusal can only be the guard.
	stub = createServer((_req, res) => {
		stubHits++;
		res.setHeader('content-type', 'application/json');
		res.end('{"leaked":true}');
	});
	await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
	stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
});

afterAll(async () => {
	stub.closeAllConnections();
	await new Promise<void>((resolve) => stub.close(() => resolve()));
	await safeClose(db);
});

const admin = (toolName: string, args: Record<string, unknown>) =>
	callMcpTool(app, token, toolName, { project: projectSlug, ...args });

describe('server-side fetches of agent-supplied URLs', () => {
	it('fetch_skill_file refuses the cloud metadata address and stores nothing', async () => {
		const url = 'http://169.254.169.254/metadata/v1/user-data';
		const result = await admin('fetch_skill_file', { url });
		expect(String(result.error)).toContain('blocked');
		const stored = await db.query('SELECT 1 FROM skills WHERE source_url = $1', [url]);
		expect(stored.rows).toHaveLength(0);
	});

	it('add_connector refuses to probe a loopback MCP server and keeps it out of runs', async () => {
		const result = (await admin('add_connector', {
			name: 'guard-probe',
			kind: 'saas',
			config: { url: `${stubUrl}/mcp` },
		})) as { reachable: boolean; probe: string; note: string };
		expect(result.reachable).toBe(false);
		expect(result.probe).toBe('unreachable');
		expect(result.note).toContain('blocked');
		expect(stubHits).toBe(0);
	});

	it('test_connector refuses to probe it either', async () => {
		const row = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'guard-probe'`,
		);
		const result = await admin('test_connector', { connector_id: row.rows[0].id });
		expect(result.ok).toBe(false);
		expect(String(result.error)).toContain('blocked');
		expect(stubHits).toBe(0);
	});
});
