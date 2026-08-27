import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { startTestMcpHttpServer, type TestMcpServer } from './helpers/test-mcp-http-server';

/**
 * The operator-facing "Test connection" action, on both surfaces.
 *
 * What separates this from the method-list refresh it replaced is the contract:
 * a probe that fails is this request succeeding, so the caller gets 200 and a
 * verdict rather than a 400 it has to turn back into a sentence. These cases
 * pin that, plus the health evidence the probe is expected to leave behind -
 * the card, the project banner and the run gate all read those columns.
 */
let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let projectSlug: string;
let teamId: string;
let live: TestMcpServer;
let dead: TestMcpServer;

interface Verdict {
	reachable: boolean;
	probe: string | null;
	note: string;
}

/** Seed a connector directly, so a test can start from a state the API will
 * not produce - a stale probe verdict, or a non-hosted kind. */
async function seedConnector(opts: {
	url?: string;
	kind?: string;
	projectId?: string | null;
	probeError?: string | null;
	probedAt?: boolean;
	config?: Record<string, unknown>;
}): Promise<string> {
	const name = `svc-${Math.random().toString(36).slice(2, 10)}`;
	const config = opts.config ?? { url: opts.url };
	const r = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, probed_at, probe_error)
		 VALUES ($1, $2::mcp_connection_kind, $3::jsonb, 'installed', $4,
		         CASE WHEN $5::boolean THEN now() ELSE NULL END,
		         $6::connector_probe_error)
		 RETURNING id`,
		[
			name,
			opts.kind ?? 'saas',
			JSON.stringify(config),
			opts.projectId ?? null,
			opts.probedAt ?? false,
			opts.probeError ?? null,
		],
	);
	return r.rows[0].id;
}

async function probeRow(id: string) {
	const r = await db.query<{ probed_at: string | null; probe_error: string | null }>(
		`SELECT probed_at::text AS probed_at, probe_error::text AS probe_error
		 FROM mcp_connections WHERE id = $1`,
		[id],
	);
	return r.rows[0];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Connector Test Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = (await (await createTestProject(db, teamId, { name: 'Probe Project' })).json()).data
		.slug;

	live = await startTestMcpHttpServer({ tools: [{ name: 'echo', description: 'Echo' }] });
	// 503 rather than 401: an auth refusal is a different verdict, asserted below.
	dead = await startTestMcpHttpServer({ failWithStatus: 503 });
});

afterAll(async () => {
	await live.close();
	await dead.close();
	await safeClose(db);
});

async function projectTest(connectorId: string) {
	return app.request(`/api/projects/${projectSlug}/connectors/${connectorId}/test`, {
		method: 'POST',
		headers: authHeader(token),
	});
}

describe('POST /projects/:projectId/connectors/:id/test', () => {
	it('reports a server that answers, and clears a stale unreachable verdict', async () => {
		const projectId = (
			await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [projectSlug])
		).rows[0].id;
		const id = await seedConnector({
			url: `http://127.0.0.1:${live.port}/mcp`,
			projectId,
			probedAt: true,
			probeError: 'unreachable',
		});

		const res = await projectTest(id);
		expect(res.status).toBe(200);
		const body = (await res.json()).data as { verdict: Verdict; connector: { id: string } };
		expect(body.verdict.reachable).toBe(true);
		expect(body.verdict.probe).toBe('ok');
		expect(body.verdict.note).toContain('reaches agent runs');

		// The stale verdict is gone, which is the whole point: nothing else
		// re-probes a row once it is credentialed, so before this button that
		// notice could outlive the outage indefinitely.
		expect((await probeRow(id)).probe_error).toBeNull();
		// The response carries the row as the probe just left it, not as it stood
		// before, so the caller does not need a second round trip to redraw.
		expect(body.connector.id).toBe(id);
	});

	it('answers 200 with an unreachable verdict when the server refuses, and records it', async () => {
		const projectId = (
			await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [projectSlug])
		).rows[0].id;
		const id = await seedConnector({ url: `http://127.0.0.1:${dead.port}/mcp`, projectId });

		const res = await projectTest(id);
		// A failed probe is a successful request. The old refresh route returned
		// 400 here, which made every caller unpick an error to find a verdict.
		expect(res.status).toBe(200);
		const { verdict } = (await res.json()).data as { verdict: Verdict };
		expect(verdict.reachable).toBe(false);
		expect(verdict.probe).toBe('unreachable');

		const row = await probeRow(id);
		expect(row.probe_error).toBe('unreachable');
		expect(row.probed_at).not.toBeNull();
	});

	it('tests a global connector from a project page', async () => {
		// Global rows are read-only from a project in every other respect. A probe
		// reads the server and widens no access, so it is allowed here.
		const id = await seedConnector({ url: `http://127.0.0.1:${live.port}/mcp`, projectId: null });
		const res = await projectTest(id);
		expect(res.status).toBe(200);
		expect(((await res.json()).data as { verdict: Verdict }).verdict.reachable).toBe(true);
	});

	it('refuses a kind with no MCP server to reach, and leaves its evidence alone', async () => {
		for (const kind of ['local', 'api'] as const) {
			const id = await seedConnector({
				kind,
				config:
					kind === 'local'
						? { command: 'run-me' }
						: { base_url: 'https://api.example.com', allowed_hosts: ['api.example.com'] },
			});
			const res = await projectTest(id);
			expect(res.status).toBe(400);
			expect((await res.json()).error.message).toContain('hosted MCP servers');
			// Refused before any probe ran, so nothing was measured and nothing stamped.
			expect((await probeRow(id)).probed_at).toBeNull();
		}
	});

	it('404s for a connector belonging to another project', async () => {
		const otherTeam = (await (await createTestTeam(db, { name: 'Other Co' })).json()).data.id;
		const otherProject = (
			await (await createTestProject(db, otherTeam, { name: 'Elsewhere' })).json()
		).data.id;
		const id = await seedConnector({
			url: `http://127.0.0.1:${live.port}/mcp`,
			projectId: otherProject,
		});
		expect((await projectTest(id)).status).toBe(404);
	});
});

describe('POST /connectors/:id/test', () => {
	it('tests a connector from the admin surface', async () => {
		const id = await seedConnector({ url: `http://127.0.0.1:${live.port}/mcp`, projectId: null });
		const res = await app.request(`/api/connectors/${id}/test`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()).data as { verdict: Verdict }).verdict.reachable).toBe(true);
	});

	it('is superuser-only', async () => {
		const member = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		const memberToken = await signAdminJwt(masterKeyManager, member.rows[0].id);
		const id = await seedConnector({ url: `http://127.0.0.1:${live.port}/mcp`, projectId: null });
		const res = await app.request(`/api/connectors/${id}/test`, {
			method: 'POST',
			headers: authHeader(memberToken),
		});
		expect(res.status).toBe(403);
	});

	it('404s for an unknown connector', async () => {
		const res = await app.request('/api/connectors/00000000-0000-0000-0000-000000000000/test', {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});
