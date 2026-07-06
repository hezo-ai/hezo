import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '018_scope_connections_per_project.sql';

/**
 * 018 scopes oauth_connections + mcp_connections by project. Seed at 017 (both
 * tables still instance-global) with a mix that exercises every backfill branch,
 * then assert the migration preserves the rows AND applies the scoping.
 */
describe('018_scope_connections_per_project migration', () => {
	let h: DataPreservationHarness;
	let projectAId: string;
	let projectBId: string;
	let connAId: string; // github, repos only in project A  -> backfills to A
	let connSharedId: string; // github, repos in A and B     -> stays global
	let connSaasId: string; // saas, no repos                 -> stays global
	let connectorGithubAId: string; // linked to connA        -> backfills to A
	let connectorSharedId: string; // linked to connSaas      -> stays global

	async function seedSecret(name: string): Promise<string> {
		const r = await h.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ($1, 'enc') RETURNING id`,
			[name],
		);
		return r.rows[0].id;
	}

	async function seedConnection(
		provider: string,
		accountId: string,
		label: string,
	): Promise<string> {
		const secretId = await seedSecret(`OAUTH_${accountId}`);
		const r = await h.db.query<{ id: string }>(
			`INSERT INTO oauth_connections
			   (provider, provider_account_id, provider_account_label, access_token_secret_id)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			[provider, accountId, label, secretId],
		);
		return r.rows[0].id;
	}

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const teamA = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamB = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Globex', 'globex') RETURNING id`,
		);
		const projectA = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Site', 'site', 'SITE') RETURNING id`,
			[teamA.rows[0].id],
		);
		const projectB = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'App', 'app', 'APP') RETURNING id`,
			[teamB.rows[0].id],
		);
		projectAId = projectA.rows[0].id;
		projectBId = projectB.rows[0].id;

		connAId = await seedConnection('github', 'gh-acme', 'acme-agent');
		connSharedId = await seedConnection('github', 'gh-shared', 'shared-agent');
		connSaasId = await seedConnection('datocms', 'dato-1', 'DatoCMS');

		// connA: one repo in project A only.
		await h.db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id)
			 VALUES ($1, 'acme/site', 'github', $2)`,
			[projectAId, connAId],
		);
		// connShared: repos in BOTH projects → ambiguous, stays global.
		await h.db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id)
			 VALUES ($1, 'shared/one', 'github', $2)`,
			[projectAId, connSharedId],
		);
		await h.db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id)
			 VALUES ($1, 'shared/two', 'github', $2)`,
			[projectBId, connSharedId],
		);

		const connectorGithubA = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, oauth_connection_id)
			 VALUES ('github', 'saas', $1) RETURNING id`,
			[connAId],
		);
		connectorGithubAId = connectorGithubA.rows[0].id;
		const connectorShared = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, oauth_connection_id)
			 VALUES ('shared-docs', 'saas', $1) RETURNING id`,
			[connSaasId],
		);
		connectorSharedId = connectorShared.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds project_id to both tables', async () => {
		const cols = await h.db.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.columns
			 WHERE column_name = 'project_id' AND table_name IN ('oauth_connections', 'mcp_connections')`,
		);
		expect(cols.rows.map((r) => r.table_name).sort()).toEqual([
			'mcp_connections',
			'oauth_connections',
		]);
	});

	it('backfills a single-project oauth connection to that project', async () => {
		const r = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM oauth_connections WHERE id = $1`,
			[connAId],
		);
		expect(r.rows[0].project_id).toBe(projectAId);
	});

	it('leaves a multi-project oauth connection global', async () => {
		const r = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM oauth_connections WHERE id = $1`,
			[connSharedId],
		);
		expect(r.rows[0].project_id).toBeNull();
	});

	it('leaves a repo-less saas oauth connection global', async () => {
		const r = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM oauth_connections WHERE id = $1`,
			[connSaasId],
		);
		expect(r.rows[0].project_id).toBeNull();
	});

	it('backfills a connector from its linked oauth connection', async () => {
		const github = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM mcp_connections WHERE id = $1`,
			[connectorGithubAId],
		);
		expect(github.rows[0].project_id).toBe(projectAId);
		const shared = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM mcp_connections WHERE id = $1`,
			[connectorSharedId],
		);
		expect(shared.rows[0].project_id).toBeNull();
	});

	it('preserves every seeded row', async () => {
		const oauth = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM oauth_connections`,
		);
		expect(oauth.rows[0].c).toBe(3);
		const mcp = await h.db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM mcp_connections`);
		expect(mcp.rows[0].c).toBe(2);
		const repos = await h.db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM repos`);
		expect(repos.rows[0].c).toBe(3);
	});

	it('allows the same upstream account in two different projects', async () => {
		const s1 = await seedSecret('OAUTH_dup_a');
		const s2 = await seedSecret('OAUTH_dup_b');
		await h.db.query(
			`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, project_id)
			 VALUES ('github', 'gh-dup', 'dup-a', $1, $2)`,
			[s1, projectAId],
		);
		await expect(
			h.db.query(
				`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, project_id)
				 VALUES ('github', 'gh-dup', 'dup-b', $1, $2)`,
				[s2, projectBId],
			),
		).resolves.toBeDefined();
	});

	it('rejects a duplicate upstream account within one project', async () => {
		const s = await seedSecret('OAUTH_dup_conflict');
		await expect(
			h.db.query(
				`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, project_id)
				 VALUES ('github', 'gh-dup', 'dup-again', $1, $2)`,
				[s, projectAId],
			),
		).rejects.toThrow();
	});

	it('allows the same connector name in two projects but rejects two globals', async () => {
		await h.db.query(
			`INSERT INTO mcp_connections (name, kind, project_id) VALUES ('github', 'saas', $1)`,
			[projectBId],
		);
		// A second global connector named 'github' collides with the pre-existing
		// backfilled row only if that stayed global — it moved to project A, so a
		// fresh global 'github' is allowed once, but a second global is not.
		await h.db.query(`INSERT INTO mcp_connections (name, kind) VALUES ('linear', 'saas')`);
		await expect(
			h.db.query(`INSERT INTO mcp_connections (name, kind) VALUES ('linear', 'saas')`),
		).rejects.toThrow();
	});
});
