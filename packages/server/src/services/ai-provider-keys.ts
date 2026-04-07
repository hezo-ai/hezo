import type { PGlite } from '@electric-sql/pglite';
import { type AiAuthMethod, type AiProvider, AiProviderStatus } from '@hezo/shared';
import { decrypt, encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';

export interface AiProviderCredential {
	value: string;
	authMethod: AiAuthMethod;
}

export interface AiProviderConfig {
	id: string;
	provider: AiProvider;
	auth_method: AiAuthMethod;
	label: string;
	is_default: boolean;
	status: string;
	metadata: Record<string, unknown>;
	created_at: string;
}

export async function storeAiProviderKey(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	companyId: string,
	provider: AiProvider,
	credential: string,
	authMethod: AiAuthMethod,
	label: string,
	metadata: Record<string, unknown> = {},
): Promise<string> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const encryptedValue = encrypt(credential, encryptionKey);
	const secretName = `${provider}_ai_${authMethod}`;

	// Create the secret
	const secretResult = await db.query<{ id: string }>(
		`INSERT INTO secrets (company_id, name, encrypted_value, category)
		 VALUES ($1, $2, $3, 'api_token')
		 RETURNING id`,
		[companyId, secretName, encryptedValue],
	);
	const secretId = secretResult.rows[0].id;

	// Check if this is the first config for this provider → auto-default
	const existing = await db.query<{ id: string }>(
		`SELECT id FROM ai_provider_configs WHERE company_id = $1 AND provider = $2::ai_provider`,
		[companyId, provider],
	);
	const isDefault = existing.rows.length === 0;

	// Create the provider config
	const configResult = await db.query<{ id: string }>(
		`INSERT INTO ai_provider_configs (company_id, provider, auth_method, label, api_key_secret_id, is_default, metadata)
		 VALUES ($1, $2::ai_provider, $3::ai_auth_method, $4, $5, $6, $7::jsonb)
		 RETURNING id`,
		[companyId, provider, authMethod, label, secretId, isDefault, JSON.stringify(metadata)],
	);

	return configResult.rows[0].id;
}

export async function getProviderCredential(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	companyId: string,
	provider: AiProvider,
): Promise<AiProviderCredential | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	// Prefer default config; fall back to any active config
	const result = await db.query<{ auth_method: AiAuthMethod; encrypted_value: string }>(
		`SELECT apc.auth_method, s.encrypted_value
		 FROM ai_provider_configs apc
		 JOIN secrets s ON s.id = apc.api_key_secret_id
		 WHERE apc.company_id = $1 AND apc.provider = $2::ai_provider AND apc.status = $3
		 ORDER BY apc.is_default DESC, apc.created_at ASC
		 LIMIT 1`,
		[companyId, provider, AiProviderStatus.Active],
	);

	if (result.rows.length === 0) return null;

	const row = result.rows[0];
	return {
		value: decrypt(row.encrypted_value, encryptionKey),
		authMethod: row.auth_method,
	};
}

export async function listAiProviders(db: PGlite, companyId: string): Promise<AiProviderConfig[]> {
	const result = await db.query<AiProviderConfig>(
		`SELECT id, provider, auth_method, label, is_default, status, metadata, created_at::text
		 FROM ai_provider_configs
		 WHERE company_id = $1
		 ORDER BY provider ASC, is_default DESC, created_at ASC`,
		[companyId],
	);
	return result.rows;
}

export async function deleteAiProviderConfig(
	db: PGlite,
	companyId: string,
	configId: string,
): Promise<boolean> {
	// Get the secret ID to delete it too
	const config = await db.query<{ api_key_secret_id: string }>(
		`SELECT api_key_secret_id FROM ai_provider_configs WHERE id = $1 AND company_id = $2`,
		[configId, companyId],
	);

	if (config.rows.length === 0) return false;

	// Delete config (secret cascades via ON DELETE CASCADE on the FK)
	await db.query('DELETE FROM secrets WHERE id = $1', [config.rows[0].api_key_secret_id]);

	return true;
}

export async function setDefaultAiProvider(
	db: PGlite,
	companyId: string,
	configId: string,
): Promise<boolean> {
	const config = await db.query<{ provider: string }>(
		`SELECT provider FROM ai_provider_configs WHERE id = $1 AND company_id = $2`,
		[configId, companyId],
	);

	if (config.rows.length === 0) return false;

	const provider = config.rows[0].provider;

	// Unset all defaults for this provider, then set the requested one
	await db.query(
		`UPDATE ai_provider_configs SET is_default = false WHERE company_id = $1 AND provider = $2::ai_provider`,
		[companyId, provider],
	);
	await db.query(
		`UPDATE ai_provider_configs SET is_default = true, updated_at = now() WHERE id = $1`,
		[configId],
	);

	return true;
}

export async function getAiProviderStatus(
	db: PGlite,
	companyId: string,
): Promise<{ configured: boolean; providers: string[] }> {
	const result = await db.query<{ provider: string }>(
		`SELECT DISTINCT provider FROM ai_provider_configs WHERE company_id = $1 AND status = $2`,
		[companyId, AiProviderStatus.Active],
	);

	return {
		configured: result.rows.length > 0,
		providers: result.rows.map((r) => r.provider),
	};
}
