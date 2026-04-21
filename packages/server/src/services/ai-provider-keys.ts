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
	default_model: string | null;
	metadata: Record<string, unknown>;
	created_at: string;
}

function deriveLabel(provider: AiProvider, existingCount: number): string {
	return existingCount === 0 ? provider : `${provider}-${existingCount + 1}`;
}

export async function storeAiProviderKey(
	db: PGlite,
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

	const existing = await db.query<{ id: string }>(
		`SELECT id FROM ai_provider_configs WHERE provider = $1::ai_provider`,
		[provider],
	);
	const isDefault = existing.rows.length === 0;
	const resolvedLabel = label?.trim() || deriveLabel(provider, existing.rows.length);

	const configResult = await db.query<{ id: string }>(
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, metadata)
		 VALUES ($1::ai_provider, $2::ai_auth_method, $3, $4, $5, $6::jsonb)
		 RETURNING id`,
		[provider, authMethod, resolvedLabel, encryptedValue, isDefault, JSON.stringify(metadata)],
	);

	return configResult.rows[0].id;
}

export async function getProviderCredential(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	provider: AiProvider,
): Promise<AiProviderCredential | null> {
	const result = await getProviderCredentialAndModel(db, masterKeyManager, provider);
	if (!result) return null;
	return { value: result.value, authMethod: result.authMethod };
}

export interface AiProviderCredentialAndModel extends AiProviderCredential {
	configId: string;
	defaultModel: string | null;
}

export async function getProviderCredentialAndModel(
	db: PGlite,
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
	}>(
		`SELECT id, auth_method, encrypted_credential, default_model
		 FROM ai_provider_configs
		 WHERE provider = $1::ai_provider AND status = $2
		 ORDER BY is_default DESC, created_at ASC
		 LIMIT 1`,
		[provider, AiProviderStatus.Active],
	);

	if (result.rows.length === 0) return null;

	const row = result.rows[0];
	return {
		configId: row.id,
		value: decrypt(row.encrypted_credential, encryptionKey),
		authMethod: row.auth_method,
		defaultModel: row.default_model,
	};
}

export async function listAiProviders(db: PGlite): Promise<AiProviderConfig[]> {
	const result = await db.query<AiProviderConfig>(
		`SELECT id, provider, auth_method, label, is_default, status, default_model, metadata, created_at::text
		 FROM ai_provider_configs
		 ORDER BY provider ASC, is_default DESC, created_at ASC`,
	);
	return result.rows;
}

export async function setProviderDefaultModel(
	db: PGlite,
	configId: string,
	model: string | null,
): Promise<boolean> {
	const result = await db.query<{ id: string }>(
		`UPDATE ai_provider_configs
		 SET default_model = $1, updated_at = now()
		 WHERE id = $2
		 RETURNING id`,
		[model, configId],
	);
	return result.rows.length > 0;
}

export async function deleteAiProviderConfig(db: PGlite, configId: string): Promise<boolean> {
	const result = await db.query<{ id: string }>(
		`DELETE FROM ai_provider_configs WHERE id = $1 RETURNING id`,
		[configId],
	);
	return result.rows.length > 0;
}

export async function setDefaultAiProvider(db: PGlite, configId: string): Promise<boolean> {
	const config = await db.query<{ provider: string }>(
		`SELECT provider FROM ai_provider_configs WHERE id = $1`,
		[configId],
	);

	if (config.rows.length === 0) return false;

	const provider = config.rows[0].provider;

	await db.query('BEGIN');
	try {
		await db.query(
			`UPDATE ai_provider_configs SET is_default = false WHERE provider = $1::ai_provider AND id <> $2`,
			[provider, configId],
		);
		await db.query(
			`UPDATE ai_provider_configs SET is_default = true, updated_at = now() WHERE id = $1`,
			[configId],
		);
		await db.query('COMMIT');
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}

	return true;
}

export async function getAiProviderStatus(
	db: PGlite,
): Promise<{ configured: boolean; providers: string[] }> {
	const result = await db.query<{ provider: string }>(
		`SELECT DISTINCT provider FROM ai_provider_configs WHERE status = $1`,
		[AiProviderStatus.Active],
	);

	return {
		configured: result.rows.length > 0,
		providers: result.rows.map((r) => r.provider),
	};
}

export async function getProviderConfigCredential(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	configId: string,
): Promise<{ provider: string; authMethod: string; value: string } | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const result = await db.query<{
		provider: string;
		auth_method: string;
		encrypted_credential: string;
	}>(
		`SELECT provider, auth_method, encrypted_credential
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
	};
}
