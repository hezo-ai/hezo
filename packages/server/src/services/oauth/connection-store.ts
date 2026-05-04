import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { encrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import { logger } from '../../logger';

const log = logger.child('oauth-connections');

export interface OAuthConnectionRow {
	id: string;
	companyId: string;
	provider: string;
	providerAccountId: string;
	providerAccountLabel: string;
	accessTokenSecretId: string;
	accessTokenSecretName: string;
	refreshTokenSecretId: string | null;
	scopes: string[];
	expiresAt: Date | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
}

export interface ConnectionStoreDeps {
	db: PGlite;
	masterKeyManager: MasterKeyManager;
}

export interface CreateConnectionInput {
	companyId: string;
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
 * short while remaining unique per (company, project=NULL).
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

	await deps.db.query('BEGIN');
	try {
		const accessSecret = await deps.db.query<{ id: string }>(
			`INSERT INTO secrets (company_id, project_id, name, encrypted_value, category, allowed_hosts, allow_all_hosts)
			 VALUES ($1, NULL, $2, $3, 'api_token', $4, false)
			 RETURNING id`,
			[input.companyId, accessName, encrypt(input.accessToken, key), allowedHosts],
		);
		const accessSecretId = accessSecret.rows[0].id;

		let refreshSecretId: string | null = null;
		if (input.refreshToken && refreshName) {
			const refreshSecret = await deps.db.query<{ id: string }>(
				`INSERT INTO secrets (company_id, project_id, name, encrypted_value, category, allowed_hosts, allow_all_hosts)
				 VALUES ($1, NULL, $2, $3, 'api_token', $4, false)
				 RETURNING id`,
				[input.companyId, refreshName, encrypt(input.refreshToken, key), allowedHosts],
			);
			refreshSecretId = refreshSecret.rows[0].id;
		}

		const conn = await deps.db.query<{
			id: string;
			company_id: string;
			provider: string;
			provider_account_id: string;
			provider_account_label: string;
			access_token_secret_id: string;
			refresh_token_secret_id: string | null;
			scopes: string[];
			expires_at: Date | null;
			metadata: Record<string, unknown>;
			created_at: Date;
			updated_at: Date;
		}>(
			`INSERT INTO oauth_connections
				(id, company_id, provider, provider_account_id, provider_account_label,
				 access_token_secret_id, refresh_token_secret_id, scopes, expires_at, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT (company_id, provider, provider_account_id)
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
				input.companyId,
				input.provider,
				input.providerAccountId,
				input.providerAccountLabel,
				accessSecretId,
				refreshSecretId,
				input.scopes,
				input.expiresAt ?? null,
				JSON.stringify(input.metadata ?? {}),
			],
		);

		await deps.db.query('COMMIT');
		const row = { ...conn.rows[0], access_token_secret_name: accessName };
		log.info('oauth connection created', {
			id: row.id,
			provider: row.provider,
			account: row.provider_account_label,
		});
		return mapRow(row, accessName);
	} catch (e) {
		await deps.db.query('ROLLBACK');
		throw e;
	}
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

export async function getConnectionForCompany(
	deps: ConnectionStoreDeps,
	companyId: string,
	connectionId: string,
): Promise<OAuthConnectionRow | null> {
	const result = await deps.db.query<RawConnRow>(
		`SELECT oc.*, s.name AS access_token_secret_name
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id
		 WHERE oc.id = $1 AND oc.company_id = $2`,
		[connectionId, companyId],
	);
	if (result.rows.length === 0) return null;
	return mapRow(result.rows[0], result.rows[0].access_token_secret_name);
}

export async function listConnectionsForCompany(
	deps: ConnectionStoreDeps,
	companyId: string,
): Promise<OAuthConnectionRow[]> {
	const result = await deps.db.query<RawConnRow>(
		`SELECT oc.*, s.name AS access_token_secret_name
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id
		 WHERE oc.company_id = $1
		 ORDER BY oc.created_at DESC`,
		[companyId],
	);
	return result.rows.map((r) => mapRow(r, r.access_token_secret_name));
}

export async function findConnectionByAccount(
	deps: ConnectionStoreDeps,
	companyId: string,
	provider: string,
	providerAccountId: string,
): Promise<OAuthConnectionRow | null> {
	const result = await deps.db.query<RawConnRow>(
		`SELECT oc.*, s.name AS access_token_secret_name
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id
		 WHERE oc.company_id = $1 AND oc.provider = $2 AND oc.provider_account_id = $3`,
		[companyId, provider, providerAccountId],
	);
	if (result.rows.length === 0) return null;
	return mapRow(result.rows[0], result.rows[0].access_token_secret_name);
}

export async function deleteConnection(
	deps: ConnectionStoreDeps,
	connectionId: string,
): Promise<boolean> {
	await deps.db.query('BEGIN');
	try {
		const conn = await deps.db.query<{
			access_token_secret_id: string;
			refresh_token_secret_id: string | null;
		}>(
			`SELECT access_token_secret_id, refresh_token_secret_id
			 FROM oauth_connections WHERE id = $1`,
			[connectionId],
		);
		if (conn.rows.length === 0) {
			await deps.db.query('ROLLBACK');
			return false;
		}
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

		await deps.db.query('COMMIT');
		log.info('oauth connection deleted', { id: connectionId });
		return true;
	} catch (e) {
		await deps.db.query('ROLLBACK');
		throw e;
	}
}

export async function updateTokens(
	deps: ConnectionStoreDeps,
	input: UpdateTokensInput,
): Promise<void> {
	const key = deps.masterKeyManager.getKey();
	if (!key) throw new Error('Master key is locked');

	const conn = await getConnection(deps, input.connectionId);
	if (!conn) throw new Error(`oauth_connection ${input.connectionId} not found`);

	await deps.db.query('BEGIN');
	try {
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
				`INSERT INTO secrets (company_id, project_id, name, encrypted_value, category, allowed_hosts, allow_all_hosts)
				 SELECT company_id, NULL, $1, $2, 'api_token', allowed_hosts, allow_all_hosts
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

		await deps.db.query('COMMIT');
	} catch (e) {
		await deps.db.query('ROLLBACK');
		throw e;
	}
}

interface RawConnRow {
	id: string;
	company_id: string;
	provider: string;
	provider_account_id: string;
	provider_account_label: string;
	access_token_secret_id: string;
	access_token_secret_name: string;
	refresh_token_secret_id: string | null;
	scopes: string[];
	expires_at: Date | null;
	metadata: Record<string, unknown>;
	created_at: Date;
	updated_at: Date;
}

function mapRow(row: RawConnRow, accessName: string): OAuthConnectionRow {
	return {
		id: row.id,
		companyId: row.company_id,
		provider: row.provider,
		providerAccountId: row.provider_account_id,
		providerAccountLabel: row.provider_account_label,
		accessTokenSecretId: row.access_token_secret_id,
		accessTokenSecretName: accessName,
		refreshTokenSecretId: row.refresh_token_secret_id,
		scopes: row.scopes ?? [],
		expiresAt: row.expires_at,
		metadata: row.metadata ?? {},
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
