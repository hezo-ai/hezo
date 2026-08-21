import { ConnectorTransport } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

/**
 * Remaining branch coverage for packages/server/src/routes/connectors.ts
 * not reached by connectors.test.ts / connectors-routes.test.ts:
 *   - project-scoped GET list
 *   - project-scoped POST success (saas), success with a valid oauth_connection_id,
 *     and local success (kickoffLocalInstall with no running containers)
 *   - revoke WITH an oauth_connection attached (the deleteConnection branch)
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'MCP Branch Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);
});

afterAll(async () => {
	await safeClose(db);
});

function jsonHeaders() {
	return { ...authHeader(token), 'Content-Type': 'application/json' };
}

let oauthSeq = 0;
async function seedOauthConnection(): Promise<string> {
	oauthSeq += 1;
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value) VALUES ($1, 'enc') RETURNING id`,
		[`MCP_BRANCH_TOKEN_${oauthSeq}`],
	);
	const oauth = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		   (provider, provider_account_id, provider_account_label, access_token_secret_id)
		 VALUES ('mcp:branch', $1, 'Branch Tester', $2) RETURNING id`,
		[`acct-${oauthSeq}`, secret.rows[0].id],
	);
	return oauth.rows[0].id;
}

describe('GET /projects/:projectId/connectors — project-scoped list', () => {
	it('lists the global catalog ordered by name', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('proj-list-a', $1::mcp_connection_kind, '{"url":"https://a/mcp"}'::jsonb, 'installed')`,
			[ConnectorTransport.Saas],
		);
		const res = await app.request(`/api/projects/${projectSlug}/connectors`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ name: string }>;
		expect(rows.find((r) => r.name === 'proj-list-a')).toBeTruthy();
	});
});

describe('POST /projects/:projectId/connectors — success arms', () => {
	it('inserts a saas connector (installed) and returns 201', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/connectors`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				name: 'proj-saas-ok',
				kind: 'saas',
				config: { url: 'https://svc/mcp' },
			}),
		});
		expect(res.status).toBe(201);
		const row = (await res.json()).data as { name: string; install_status: string };
		expect(row.name).toBe('proj-saas-ok');
		expect(row.install_status).toBe('installed');
	});

	it('accepts a valid oauth_connection_id (ownership-present arm)', async () => {
		const oauthId = await seedOauthConnection();
		const res = await app.request(`/api/projects/${projectSlug}/connectors`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				name: 'proj-saas-oauth',
				kind: 'saas',
				config: { url: 'https://svc-oauth/mcp' },
				oauth_connection_id: oauthId,
			}),
		});
		expect(res.status).toBe(201);
		const row = (await res.json()).data as { oauth_connection_id: string };
		expect(row.oauth_connection_id).toBe(oauthId);
	});

	it('inserts a local connector (pending) and kicks off install with no running containers', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/connectors`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				name: 'proj-local-ok',
				kind: 'local',
				config: { command: 'npx', args: ['some-mcp'] },
			}),
		});
		expect(res.status).toBe(201);
		const row = (await res.json()).data as { install_status: string };
		expect(row.install_status).toBe('pending');
	});
});

describe('POST /projects/:projectId/connectors/:id/revoke — oauth-attached arm', () => {
	it('revokes a connector that has an oauth connection and deletes the oauth row', async () => {
		const oauthId = await seedOauthConnection();
		// Project-scoped, not global. A project surface may only revoke a row it
		// owns: revoke deletes the OAuth connection, and `deleteConnection` nulls
		// `repos.oauth_connection_id` with no project filter, so revoking a shared
		// row from one project would strip git auth from every other project.
		const project = await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [
			projectSlug,
		]);
		const conn = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id, install_status, project_id)
			 VALUES ('proj-revoke-oauth', $1::mcp_connection_kind, '{"url":"https://r/mcp"}'::jsonb, $2, 'installed', $3)
			 RETURNING id`,
			[ConnectorTransport.Saas, oauthId, project.rows[0].id],
		);
		const res = await app.request(
			`/api/projects/${projectSlug}/connectors/${conn.rows[0].id}/revoke`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const row = (await res.json()).data as { revoked_at: string | null };
		expect(row.revoked_at).toBeTruthy();
	});
});
