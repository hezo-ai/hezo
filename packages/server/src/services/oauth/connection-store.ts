import { randomUUID } from 'node:crypto';
import { encrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { withTransaction } from '../../lib/sql';
import { logger } from '../../logger';

const log = logger.child('oauth-connections');

export interface OAuthConnectionRow {
	id: string;
	provider: string;
	providerAccountId: string;
	providerAccountLabel: string;
	accessTokenSecretId: string;
	accessTokenSecretName: string;
	refreshTokenSecretId: string | null;
	scopes: string[];
	expiresAt: Date | null;
	metadata: Record<string, unknown>;
	/** Owning project, or null for a global ("all projects") connection. */
	projectId: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ConnectionStoreDeps {
	db: Db;
	masterKeyManager: MasterKeyManager;
}

export interface CreateConnectionInput {
	provider: string;
	providerAccountId: string;
	providerAccountLabel: string;
	accessToken: string;
	refreshToken?: string | null;
	scopes: string[];
	expiresAt?: Date | null;
	metadata?: Record<string, unknown>;
	/** Hosts the access token is allowed to be substituted on. Required. */
	allowedHosts: string[];
	/**
	 * Owning project. A non-null value scopes the connection to that project so
	 * two projects can connect separate upstream accounts; null keeps the
	 * historical global ("all projects") scope (the instance-admin surface).
	 */
	projectId?: string | null;
}

export interface UpdateTokensInput {
	connectionId: string;
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: Date | null;
}

/**
 * Token name format: `OAUTH_<PROVIDER>_<8-char hex prefix of connection id>`.
 * The full UUID is in the FK; the prefix in the name keeps the placeholder
 * short while remaining unique per (team, project=NULL).
 */
export function oauthSecretName(
	provider: string,
	connectionId: string,
	kind: 'access' | 'refresh',
): string {
	const idPrefix = connectionId.replace(/-/g, '').slice(0, 8).toUpperCase();
	const suffix = kind === 'access' ? '' : '_REFRESH';
	return `OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${idPrefix}${suffix}`;
}

export async function createConnection(
	deps: ConnectionStoreDeps,
	input: CreateConnectionInput,
): Promise<OAuthConnectionRow> {
	const key = deps.masterKeyManager.getKey();
	if (!key) throw new Error('Master key is locked');

	const connectionId = randomUUID();
	const accessName = oauthSecretName(input.provider, connectionId, 'access');
	const refreshName = input.refreshToken
		? oauthSecretName(input.provider, connectionId, 'refresh')
		: null;
	const allowedHosts = input.allowedHosts.length > 0 ? input.allowedHosts : [];

	const row = await withTransaction(deps.db, async () => {
		const accessSecret = await deps.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts)
			 VALUES ($1, $2, 'api_token', $3, false)
			 RETURNING id`,
			[accessName, encrypt(input.accessToken, key), allowedHosts],
		);
		const accessSecretId = accessSecret.rows[0].id;

		let refreshSecretId: string | null = null;
		if (input.refreshToken && refreshName) {
			const refreshSecret = await deps.db.query<{ id: string }>(
				`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts)
				 VALUES ($1, $2, 'api_token', $3, false)
				 RETURNING id`,
				[refreshName, encrypt(input.refreshToken, key), allowedHosts],
			);
			refreshSecretId = refreshSecret.rows[0].id;
		}

		// Reconnecting the same account within the same scope updates the existing
		// row. Two partial unique indexes back the scoping (one for project_id
		// NULL, one for non-NULL), so the conflict target must name the matching
		// index for the row being written — a single ON CONFLICT can't infer both.
		const projectId = input.projectId ?? null;
		const conflictTarget = projectId
			? '(project_id, provider, provider_account_id) WHERE project_id IS NOT NULL'
			: '(provider, provider_account_id) WHERE project_id IS NULL';
		const conn = await deps.db.query<RawConnRow>(
			`INSERT INTO oauth_connections
				(id, provider, provider_account_id, provider_account_label,
				 access_token_secret_id, refresh_token_secret_id, scopes, expires_at, metadata, project_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT ${conflictTarget}
			 DO UPDATE SET
				provider_account_label = EXCLUDED.provider_account_label,
				access_token_secret_id = EXCLUDED.access_token_secret_id,
				refresh_token_secret_id = EXCLUDED.refresh_token_secret_id,
				scopes = EXCLUDED.scopes,
				expires_at = EXCLUDED.expires_at,
				metadata = EXCLUDED.metadata
			 RETURNING *`,
			[
				connectionId,
				input.provider,
				input.providerAccountId,
				input.providerAccountLabel,
				accessSecretId,
				refreshSecretId,
				input.scopes,
				input.expiresAt ?? null,
				JSON.stringify(input.metadata ?? {}),
				projectId,
			],
		);

		return { ...conn.rows[0], access_token_secret_name: accessName };
	});

	log.info('oauth connection created', {
		id: row.id,
		provider: row.provider,
		account: row.provider_account_label,
	});
	return mapRow(row, accessName);
}

export async function getConnection(
	deps: ConnectionStoreDeps,
	connectionId: string,
): Promise<OAuthConnectionRow | null> {
	const result = await deps.db.query<RawConnRow>(
		`SELECT oc.*, s.name AS access_token_secret_name
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id
		 WHERE oc.id = $1`,
		[connectionId],
	);
	if (result.rows.length === 0) return null;
	return mapRow(result.rows[0], result.rows[0].access_token_secret_name);
}

/**
 * List OAuth connections. When `projectId` is given, returns that project's own
 * connections plus global ("all projects") ones, with the project's own first so
 * a caller taking "the first github" resolves the project-scoped account over a
 * global fallback. Omit `projectId` for the instance-admin view (all rows).
 */
export async function listConnections(
	deps: ConnectionStoreDeps,
	projectId?: string | null,
): Promise<OAuthConnectionRow[]> {
	const result =
		projectId != null
			? await deps.db.query<RawConnRow>(
					`SELECT oc.*, s.name AS access_token_secret_name
					 FROM oauth_connections oc
					 JOIN secrets s ON s.id = oc.access_token_secret_id
					 WHERE oc.project_id = $1 OR oc.project_id IS NULL
					 ORDER BY (oc.project_id IS NULL) ASC, oc.created_at DESC`,
					[projectId],
				)
			: await deps.db.query<RawConnRow>(
					`SELECT oc.*, s.name AS access_token_secret_name
					 FROM oauth_connections oc
					 JOIN secrets s ON s.id = oc.access_token_secret_id
					 ORDER BY oc.created_at DESC`,
				);
	return result.rows.map((r) => mapRow(r, r.access_token_secret_name));
}

export async function findConnectionByAccount(
	deps: ConnectionStoreDeps,
	provider: string,
	providerAccountId: string,
	projectId?: string | null,
): Promise<OAuthConnectionRow | null> {
	const result = await deps.db.query<RawConnRow>(
		`SELECT oc.*, s.name AS access_token_secret_name
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id
		 WHERE oc.provider = $1 AND oc.provider_account_id = $2
		   AND oc.project_id IS NOT DISTINCT FROM $3`,
		[provider, providerAccountId, projectId ?? null],
	);
	if (result.rows.length === 0) return null;
	return mapRow(result.rows[0], result.rows[0].access_token_secret_name);
}

export async function deleteConnection(
	deps: ConnectionStoreDeps,
	connectionId: string,
): Promise<boolean> {
	const deleted = await withTransaction(deps.db, async () => {
		const conn = await deps.db.query<{
			access_token_secret_id: string;
			refresh_token_secret_id: string | null;
		}>(
			`SELECT access_token_secret_id, refresh_token_secret_id
			 FROM oauth_connections WHERE id = $1`,
			[connectionId],
		);
		if (conn.rows.length === 0) return false;
		const { access_token_secret_id, refresh_token_secret_id } = conn.rows[0];

		await deps.db.query(
			`UPDATE repos SET oauth_connection_id = NULL WHERE oauth_connection_id = $1`,
			[connectionId],
		);
		await deps.db.query(
			`UPDATE mcp_connections SET oauth_connection_id = NULL WHERE oauth_connection_id = $1`,
			[connectionId],
		);

		await deps.db.query(`DELETE FROM oauth_connections WHERE id = $1`, [connectionId]);
		await deps.db.query(`DELETE FROM secrets WHERE id = $1`, [access_token_secret_id]);
		if (refresh_token_secret_id) {
			await deps.db.query(`DELETE FROM secrets WHERE id = $1`, [refresh_token_secret_id]);
		}

		return true;
	});

	if (deleted) log.info('oauth connection deleted', { id: connectionId });
	return deleted;
}

/**
 * Delete every OAuth connection owned by a project, along with its encrypted
 * token secrets. Must run BEFORE the project (or its team) is deleted: the
 * `project_id` FK cascade would drop the `oauth_connections` / `mcp_connections`
 * rows but leave their `secrets` orphaned in the global vault (still
 * egress-substitutable within their allowed_hosts). Returns the count purged.
 */
export async function deleteProjectConnections(
	deps: ConnectionStoreDeps,
	projectId: string,
): Promise<number> {
	const rows = await deps.db.query<{ id: string }>(
		`SELECT id FROM oauth_connections WHERE project_id = $1`,
		[projectId],
	);
	for (const row of rows.rows) {
		await deleteConnection(deps, row.id);
	}
	return rows.rows.length;
}

export async function updateTokens(
	deps: ConnectionStoreDeps,
	input: UpdateTokensInput,
): Promise<void> {
	const key = deps.masterKeyManager.getKey();
	if (!key) throw new Error('Master key is locked');

	const conn = await getConnection(deps, input.connectionId);
	if (!conn) throw new Error(`oauth_connection ${input.connectionId} not found`);

	await withTransaction(deps.db, async () => {
		await deps.db.query(`UPDATE secrets SET encrypted_value = $1 WHERE id = $2`, [
			encrypt(input.accessToken, key),
			conn.accessTokenSecretId,
		]);

		if (input.refreshToken && conn.refreshTokenSecretId) {
			await deps.db.query(`UPDATE secrets SET encrypted_value = $1 WHERE id = $2`, [
				encrypt(input.refreshToken, key),
				conn.refreshTokenSecretId,
			]);
		} else if (input.refreshToken && !conn.refreshTokenSecretId) {
			const refreshName = oauthSecretName(conn.provider, conn.id, 'refresh');
			const inserted = await deps.db.query<{ id: string }>(
				`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts)
				 SELECT $1, $2, 'api_token', allowed_hosts, allow_all_hosts
				 FROM secrets WHERE id = $3
				 RETURNING id`,
				[refreshName, encrypt(input.refreshToken, key), conn.accessTokenSecretId],
			);
			await deps.db.query(
				`UPDATE oauth_connections SET refresh_token_secret_id = $1 WHERE id = $2`,
				[inserted.rows[0].id, conn.id],
			);
		}

		await deps.db.query(`UPDATE oauth_connections SET expires_at = $1 WHERE id = $2`, [
			input.expiresAt ?? null,
			conn.id,
		]);
	});
}

interface RawConnRow {
	id: string;
	provider: string;
	provider_account_id: string;
	provider_account_label: string;
	access_token_secret_id: string;
	access_token_secret_name: string;
	refresh_token_secret_id: string | null;
	scopes: string[];
	expires_at: Date | null;
	metadata: Record<string, unknown>;
	project_id: string | null;
	created_at: Date;
	updated_at: Date;
}

function mapRow(row: RawConnRow, accessName: string): OAuthConnectionRow {
	return {
		id: row.id,
		provider: row.provider,
		providerAccountId: row.provider_account_id,
		providerAccountLabel: row.provider_account_label,
		accessTokenSecretId: row.access_token_secret_id,
		accessTokenSecretName: accessName,
		refreshTokenSecretId: row.refresh_token_secret_id,
		scopes: row.scopes ?? [],
		expiresAt: row.expires_at,
		metadata: row.metadata ?? {},
		projectId: row.project_id ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
