import { type AiAuthMethod, type AiProvider, AiProviderStatus } from '@hezo/shared';
import { decrypt, encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { buildUpdateSet, withTransaction } from '../lib/sql';

export interface AiProviderCredential {
	value: string;
	authMethod: AiAuthMethod;
	/**
	 * Operator-supplied endpoint for the locally-hosted providers (Ollama, LM
	 * Studio), read from `ai_provider_configs.metadata -> 'base_url'`. Null for
	 * every hosted provider, whose endpoint is fixed in
	 * `PROVIDER_RUNTIME_ADAPTERS[...].staticEnv` instead. Carried on the credential
	 * because it is per-install and so cannot live in a compile-time constant; the
	 * runner reads it to set `ANTHROPIC_BASE_URL` and to keep the host out of the
	 * egress proxy.
	 */
	baseUrl: string | null;
}

/** Read the stored base URL off a config's jsonb metadata, if it has one. */
export function readConfigBaseUrl(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== 'object') return null;
	const raw = (metadata as Record<string, unknown>).base_url;
	return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export interface AiProviderConfig {
	id: string;
	provider: AiProvider;
	auth_method: AiAuthMethod;
	label: string;
	is_default: boolean;
	status: string;
	default_model: string | null;
	metadata: Record<string, unknown>;
	created_at: string;
}

function deriveLabel(provider: AiProvider, existingCount: number): string {
	return existingCount === 0 ? provider : `${provider}-${existingCount + 1}`;
}

export async function storeAiProviderKey(
	db: Db,
	masterKeyManager: MasterKeyManager,
	provider: AiProvider,
	credential: string,
	authMethod: AiAuthMethod,
	label?: string,
	metadata: Record<string, unknown> = {},
): Promise<string> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const encryptedValue = encrypt(credential, encryptionKey);

	const existingForProvider = await db.query<{ id: string }>(
		`SELECT id FROM ai_provider_configs WHERE provider = $1::ai_provider`,
		[provider],
	);
	// The default is a single instance-wide flag: only the first config added to
	// the instance (across all providers) becomes the default.
	const anyConfig = await db.query<{ exists: number }>(
		`SELECT 1 AS exists FROM ai_provider_configs LIMIT 1`,
	);
	const isDefault = anyConfig.rows.length === 0;
	const resolvedLabel = label?.trim() || deriveLabel(provider, existingForProvider.rows.length);

	const configResult = await db.query<{ id: string }>(
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, metadata)
		 VALUES ($1::ai_provider, $2::ai_auth_method, $3, $4, $5, $6::jsonb)
		 RETURNING id`,
		[provider, authMethod, resolvedLabel, encryptedValue, isDefault, JSON.stringify(metadata)],
	);

	return configResult.rows[0].id;
}

export async function getProviderCredential(
	db: Db,
	masterKeyManager: MasterKeyManager,
	provider: AiProvider,
): Promise<AiProviderCredential | null> {
	const result = await getProviderCredentialAndModel(db, masterKeyManager, provider);
	if (!result) return null;
	return { value: result.value, authMethod: result.authMethod, baseUrl: result.baseUrl };
}

export interface AiProviderCredentialAndModel extends AiProviderCredential {
	configId: string;
	defaultModel: string | null;
}

/**
 * Replace the encrypted credential value on an existing config row.
 * Used to persist refresh-token rotations after a Codex run mutates the
 * mounted `auth.json` blob.
 */
export async function updateAiProviderCredential(
	db: Db,
	masterKeyManager: MasterKeyManager,
	configId: string,
	value: string,
): Promise<boolean> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const encryptedValue = encrypt(value, encryptionKey);
	const result = await db.query<{ id: string }>(
		`UPDATE ai_provider_configs
		 SET encrypted_credential = $1, updated_at = now()
		 WHERE id = $2
		 RETURNING id`,
		[encryptedValue, configId],
	);
	return result.rows.length > 0;
}

export async function getProviderCredentialAndModel(
	db: Db,
	masterKeyManager: MasterKeyManager,
	provider: AiProvider,
): Promise<AiProviderCredentialAndModel | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const result = await db.query<{
		id: string;
		auth_method: AiAuthMethod;
		encrypted_credential: string;
		default_model: string | null;
		metadata: Record<string, unknown> | null;
	}>(
		`SELECT id, auth_method, encrypted_credential, default_model, metadata
		 FROM ai_provider_configs
		 WHERE provider = $1::ai_provider AND status = $2
		 ORDER BY is_default DESC, created_at ASC
		 LIMIT 1`,
		[provider, AiProviderStatus.Verified],
	);

	if (result.rows.length === 0) return null;

	const row = result.rows[0];
	return {
		configId: row.id,
		value: decrypt(row.encrypted_credential, encryptionKey),
		authMethod: row.auth_method,
		defaultModel: row.default_model,
		baseUrl: readConfigBaseUrl(row.metadata),
	};
}

export async function listAiProviders(db: Db): Promise<AiProviderConfig[]> {
	const result = await db.query<AiProviderConfig>(
		`SELECT id, provider, auth_method, label, is_default, status, default_model, metadata, created_at::text
		 FROM ai_provider_configs
		 ORDER BY provider ASC, is_default DESC, created_at ASC`,
	);
	return result.rows;
}

export interface AiProviderConfigUpdate {
	label?: string;
	defaultModel?: string | null;
}

export async function updateAiProviderConfig(
	db: Db,
	configId: string,
	fields: AiProviderConfigUpdate,
): Promise<boolean> {
	const { clauses, params, nextIdx } = buildUpdateSet([
		{ column: 'label', value: fields.label },
		{ column: 'default_model', value: fields.defaultModel },
	]);
	if (clauses.length === 0) return false;

	const result = await db.query<{ id: string }>(
		`UPDATE ai_provider_configs
		 SET ${clauses.join(', ')}, updated_at = now()
		 WHERE id = $${nextIdx}
		 RETURNING id`,
		[...params, configId],
	);
	return result.rows.length > 0;
}

export async function deleteAiProviderConfig(db: Db, configId: string): Promise<boolean> {
	const result = await db.query<{ id: string }>(
		`DELETE FROM ai_provider_configs WHERE id = $1 RETURNING id`,
		[configId],
	);
	return result.rows.length > 0;
}

export async function setDefaultAiProvider(db: Db, configId: string): Promise<boolean> {
	const config = await db.query<{ id: string }>(
		`SELECT id FROM ai_provider_configs WHERE id = $1`,
		[configId],
	);

	if (config.rows.length === 0) return false;

	// A single instance-wide default: demote every other config, then promote this one.
	await withTransaction(db, async () => {
		await db.query(
			`UPDATE ai_provider_configs SET is_default = false, updated_at = now() WHERE id <> $1 AND is_default = true`,
			[configId],
		);
		await db.query(
			`UPDATE ai_provider_configs SET is_default = true, updated_at = now() WHERE id = $1`,
			[configId],
		);
	});

	return true;
}

export async function getAiProviderStatus(
	db: Db,
): Promise<{ configured: boolean; providers: string[] }> {
	const result = await db.query<{ provider: string }>(
		`SELECT DISTINCT provider FROM ai_provider_configs WHERE status = $1`,
		[AiProviderStatus.Verified],
	);

	return {
		configured: result.rows.length > 0,
		providers: result.rows.map((r) => r.provider),
	};
}

export async function getProviderConfigCredential(
	db: Db,
	masterKeyManager: MasterKeyManager,
	configId: string,
): Promise<{
	provider: string;
	authMethod: string;
	value: string;
	baseUrl: string | null;
} | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const result = await db.query<{
		provider: string;
		auth_method: string;
		encrypted_credential: string;
		metadata: Record<string, unknown> | null;
	}>(
		`SELECT provider, auth_method, encrypted_credential, metadata
		 FROM ai_provider_configs
		 WHERE id = $1`,
		[configId],
	);

	if (result.rows.length === 0) return null;

	const row = result.rows[0];
	return {
		provider: row.provider,
		authMethod: row.auth_method,
		value: decrypt(row.encrypted_credential, encryptionKey),
		baseUrl: readConfigBaseUrl(row.metadata),
	};
}
