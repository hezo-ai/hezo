import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * Git provisioning and a connector's MCP tools ride the same OAuth token but are
 * gated by different rows: `repos.oauth_connection_id` builds the git remote,
 * `mcp_connections.oauth_connection_id` puts the connector into an agent run.
 * Deleting the connector leaves git working and silently strips every MCP tool
 * it carried - and no run log records which connectors a run received, so the
 * loss is invisible from inside. Two agent runs burned themselves diagnosing
 * exactly that as an upstream 404.
 *
 * So the agent surface refuses; the human surfaces do not, because a human may
 * legitimately want the tools gone while git keeps working, and their dialogs
 * name the repos first.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let projectId: string;
let otherProjectId: string;

async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result?: { content: Array<{ type: string; text: string }> };
		error?: { message: string };
	};
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text);
	} catch {
		return { error: text };
	}
}

/** An OAuth connection plus its vault secret. `scope` null means global. */
async function seedConnection(label: string, scope: string | null): Promise<string> {
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, 'ciphertext-placeholder', 'other', ARRAY['api.github.com'])
		 RETURNING id`,
		[`OAUTH_GITHUB_${label.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`],
	);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		     (provider, provider_account_id, provider_account_label, access_token_secret_id, project_id)
		 VALUES ('github', $1, $2, $3, $4) RETURNING id`,
		[`acct-${label}`, label, secret.rows[0].id, scope],
	);
	return conn.rows[0].id;
}

/** A saas connector, optionally linked to an OAuth connection. */
async function seedConnector(
	name: string,
	connectionId: string | null,
	scope: string | null = projectId,
): Promise<string> {
	const row = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections
		     (name, kind, config, install_status, project_id, oauth_connection_id, activated_at)
		 VALUES ($1, 'saas', $2::jsonb, 'installed', $3, $4, now())
		 RETURNING id`,
		[name, JSON.stringify({ url: 'https://api.githubcopilot.com/mcp/' }), scope, connectionId],
	);
	return row.rows[0].id;
}

async function seedRepo(identifier: string, connectionId: string, owner: string): Promise<void> {
	await db.query(
		`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id)
		 VALUES ($1, $2, 'github', $3)`,
		[owner, identifier, connectionId],
	);
}

async function connectorExists(id: string): Promise<boolean> {
	const r = await db.query<{ c: number }>(
		`SELECT count(*)::int AS c FROM mcp_connections WHERE id = $1`,
		[id],
	);
	return r.rows[0].c > 0;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Linked Repos Co' });
	const teamId = (await teamRes.json()).data.id;
	projectId = (await createTestProject(db, teamId, { name: 'Primary' }).then((r) => r.json())).data
		.id;
	otherProjectId = (
		await createTestProject(db, teamId, { name: 'Secondary' }).then((r) => r.json())
	).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('remove_connector refuses a connector that still authenticates repos', () => {
	it('refuses, names the repo, and leaves the row intact', async () => {
		const connectionId = await seedConnection('guarded', projectId);
		const connectorId = await seedConnector('github-guarded', connectionId);
		await seedRepo('hezo-ai/website', connectionId, projectId);

		const result = (await callTool('remove_connector', {
			project: projectId,
			id: 'github-guarded',
		})) as { error?: string; connector_id?: string; hint?: string; removed?: boolean };

		expect(result.removed).toBeUndefined();
		expect(result.error).toContain('hezo-ai/website');
		expect(result.connector_id).toBe(connectorId);
		// The hint has to name a way out. A refusal with no remedy is what sends an
		// agent inventing one, which is the failure this guard exists to end.
		expect(result.hint).toContain('Git page');
		expect(result.hint).toContain('list_connectors');

		expect(await connectorExists(connectorId)).toBe(true);
	});

	it('still removes a connector with no linked repos', async () => {
		const connectionId = await seedConnection('unlinked', projectId);
		const connectorId = await seedConnector('github-unlinked', connectionId);

		const result = (await callTool('remove_connector', {
			project: projectId,
			id: 'github-unlinked',
		})) as { removed?: boolean; id?: string };

		expect(result.removed).toBe(true);
		expect(result.id).toBe(connectorId);
		expect(await connectorExists(connectorId)).toBe(false);
	});

	it('still removes a connector carrying no OAuth connection at all', async () => {
		// The guard compares `oauth_connection_id` to `repos.oauth_connection_id`;
		// a NULL there must match nothing rather than everything.
		const connectorId = await seedConnector('github-nulloauth', null);

		const result = (await callTool('remove_connector', {
			project: projectId,
			id: 'github-nulloauth',
		})) as { removed?: boolean };

		expect(result.removed).toBe(true);
		expect(await connectorExists(connectorId)).toBe(false);
	});

	it('counts repos in other projects, since a global connection is the shared one', async () => {
		const connectionId = await seedConnection('crossproject', null);
		const connectorId = await seedConnector('github-crossproject', connectionId);
		await seedRepo('hezo-ai/elsewhere', connectionId, otherProjectId);

		const result = (await callTool('remove_connector', {
			project: projectId,
			id: 'github-crossproject',
		})) as { error?: string };

		expect(result.error).toContain('hezo-ai/elsewhere');
		expect(await connectorExists(connectorId)).toBe(true);
	});
});

describe('the human delete path stays unguarded', () => {
	it('deletes a connector that backs linked repos', async () => {
		// Deliberate: a human may want the MCP tools gone while git keeps working,
		// and the Connectors page names the repos before they confirm. A guard here
		// would also strand credentials, since `DELETE /api/secrets/:id` returns
		// 409 IN_USE and tells the user to remove the connector first.
		const connectionId = await seedConnection('humandelete', projectId);
		const connectorId = await seedConnector('github-humandelete', connectionId);
		await seedRepo('hezo-ai/human', connectionId, projectId);

		const res = await app.request(`/api/projects/${projectId}/connectors/${connectorId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(await connectorExists(connectorId)).toBe(false);
	});
});

describe('list_connectors carries the linkage that explains the refusal', () => {
	it('reports linked_repos across projects, and empty for an unlinked connector', async () => {
		const linkedConnection = await seedConnection('listing', null);
		await seedConnector('github-listing', linkedConnection);
		await seedRepo('hezo-ai/listed', linkedConnection, otherProjectId);
		await seedConnector('github-listing-bare', null);

		const result = (await callTool('list_connectors', { project: projectId })) as {
			items?: Array<{ name: string; linked_repos?: Array<{ repo_identifier: string }> }>;
		};
		const rows = result.items ?? [];
		const linked = rows.find((r) => r.name === 'github-listing');
		const bare = rows.find((r) => r.name === 'github-listing-bare');

		expect(linked?.linked_repos?.map((r) => r.repo_identifier)).toEqual(['hezo-ai/listed']);
		// Empty, never null - an absent array reads as "unknown" rather than "none".
		expect(bare?.linked_repos).toEqual([]);
	});
});

describe('revoke and disconnect are scoped to owned rows', () => {
	it('refuses to revoke a global connector from a project surface', async () => {
		// Revoke deletes the underlying OAuth connection, and that nulls
		// `repos.oauth_connection_id` with no project filter - so a project revoking
		// a global row stripped git auth from every other project's repos.
		const connectionId = await seedConnection('globalrevoke', null);
		const connectorId = await seedConnector('github-globalrevoke', connectionId, null);

		const res = await app.request(`/api/projects/${projectId}/connectors/${connectorId}/revoke`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);

		const still = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM oauth_connections WHERE id = $1`,
			[connectionId],
		);
		expect(still.rows[0].c).toBe(1);
	});

	it('still revokes a connector the project owns', async () => {
		const connectionId = await seedConnection('ownrevoke', projectId);
		const connectorId = await seedConnector('github-ownrevoke', connectionId);

		const res = await app.request(`/api/projects/${projectId}/connectors/${connectorId}/revoke`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});

	it('refuses to disconnect a global oauth connection from a project surface', async () => {
		const connectionId = await seedConnection('globaldisconnect', null);

		const res = await app.request(`/api/projects/${projectId}/oauth-connections/${connectionId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);

		const still = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM oauth_connections WHERE id = $1`,
			[connectionId],
		);
		expect(still.rows[0].c).toBe(1);
	});

	it('still disconnects a connection the project owns', async () => {
		const connectionId = await seedConnection('owndisconnect', projectId);

		const res = await app.request(`/api/projects/${projectId}/oauth-connections/${connectionId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});
});
