import type { PGlite } from '@electric-sql/pglite';
import { decrypt, encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';

export async function storeOAuthToken(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	companyId: string,
	platform: string,
	accessToken: string,
	scopes: string,
	metadata: Record<string, unknown>,
): Promise<string> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const encryptedToken = encrypt(accessToken, encryptionKey);
	const secretName = `${platform}_access_token`;

	// Upsert the secret
	const secretResult = await db.query<{ id: string }>(
		`INSERT INTO secrets (company_id, name, encrypted_value, category)
		 VALUES ($1, $2, $3, 'api_token')
		 ON CONFLICT (company_id, project_id, name) WHERE project_id IS NULL
		 DO UPDATE SET encrypted_value = $3, updated_at = now()
		 RETURNING id`,
		[companyId, secretName, encryptedToken],
	);
	const secretId = secretResult.rows[0].id;

	// Upsert connected_platforms
	await db.query(
		`INSERT INTO connected_platforms (company_id, platform, status, access_token_secret_id, scopes, metadata)
		 VALUES ($1, $2::platform_type, 'active', $3, $4, $5::jsonb)
		 ON CONFLICT (company_id, platform)
		 DO UPDATE SET status = 'active', access_token_secret_id = $3,
		   scopes = $4, metadata = $5::jsonb, updated_at = now()`,
		[companyId, platform, secretId, scopes, JSON.stringify(metadata)],
	);

	return secretId;
}

export async function getOAuthToken(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	companyId: string,
	platform: string,
): Promise<string | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const result = await db.query<{ encrypted_value: string }>(
		`SELECT s.encrypted_value
		 FROM connected_platforms cp
		 JOIN secrets s ON s.id = cp.access_token_secret_id
		 WHERE cp.company_id = $1 AND cp.platform = $2::platform_type AND cp.status = 'active'`,
		[companyId, platform],
	);

	if (result.rows.length === 0) return null;
	return decrypt(result.rows[0].encrypted_value, encryptionKey);
}

export async function getConnection(
	db: PGlite,
	companyId: string,
	platform: string,
): Promise<{
	id: string;
	platform: string;
	status: string;
	scopes: string;
	metadata: Record<string, unknown>;
} | null> {
	const result = await db.query<{
		id: string;
		platform: string;
		status: string;
		scopes: string;
		metadata: Record<string, unknown>;
	}>(
		`SELECT id, platform, status, scopes, metadata
		 FROM connected_platforms
		 WHERE company_id = $1 AND platform = $2::platform_type`,
		[companyId, platform],
	);
	return result.rows[0] ?? null;
}
