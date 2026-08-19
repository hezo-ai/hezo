import {
	type AgentRuntime,
	type AiAuthMethod,
	type AiProvider,
	AiProviderStatus,
	effectiveRuntime,
	isAgentRuntime,
} from '@hezo/shared';
import { decrypt, encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { buildUpdateSet, withTransaction } from '../lib/sql';
import { RUNTIME_CANDIDATE_SCAN_LIMIT } from './runtime-resolver';

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
	/**
	 * The CLI the operator chose for this credential, or null to follow the
	 * provider default. Carried here for the same reason as `baseUrl`: it is a
	 * per-credential value, so it cannot be derived from the provider alone.
	 * Resolve it with `effectiveRuntime` before building env from it — a provider
	 * supports several runtimes and each wants the credential in a different var.
	 */
	runtime: AgentRuntime | null;
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
	/** Chosen CLI, or null to follow the provider default. */
	runtime: AgentRuntime | null;
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
	runtime: AgentRuntime | null = null,
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
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, metadata, runtime)
		 VALUES ($1::ai_provider, $2::ai_auth_method, $3, $4, $5, $6::jsonb, $7::agent_runtime)
		 RETURNING id`,
		[
			provider,
			authMethod,
			resolvedLabel,
			encryptedValue,
			isDefault,
			JSON.stringify(metadata),
			runtime,
		],
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
	return {
		value: result.value,
		authMethod: result.authMethod,
		baseUrl: result.baseUrl,
		runtime: result.runtime,
	};
}

export interface AiProviderCredentialAndModel extends AiProviderCredential {
	configId: string;
	defaultModel: string | null;
}

/**
 * Which credential row a run would use, without the credential itself.
 *
 * Everything here is non-secret, so it can be read on a locked instance and held
 * in memory to answer "is the config this session was started on still the one
 * the instance would pick?" - the question a long-lived chat session has to ask
 * after an operator moves the global default.
 */
export interface SelectedProviderConfig {
	configId: string;
	authMethod: AiAuthMethod;
	defaultModel: string | null;
	baseUrl: string | null;
	/** The operator's stored CLI choice; null follows the provider default. */
	runtime: AgentRuntime | null;
	/** {@link runtime} resolved against the provider default - the CLI this row runs on. */
	resolvedRuntime: AgentRuntime | null;
}

interface ProviderConfigRow {
	id: string;
	auth_method: AiAuthMethod;
	encrypted_credential: string;
	default_model: string | null;
	metadata: Record<string, unknown> | null;
	runtime: string | null;
}

/**
 * The one selection rule: highest-priority verified credential for a provider
 * (global default first, then oldest), optionally constrained to the CLI it
 * resolves to. Both the decrypting read below and the non-secret
 * {@link selectProviderConfig} go through here, so the row a session compares
 * against can never be a different row from the one it runs on.
 */
async function selectProviderConfigRow(
	db: Db,
	provider: AiProvider,
	runtime?: AgentRuntime | null,
): Promise<(ProviderConfigRow & { resolvedRuntime: AgentRuntime | null }) | null> {
	// When filtering by runtime the matching credential may not be the
	// highest-priority one for the provider, so `LIMIT 1` would pre-select a row
	// that fails the test and report "no credential". Widen the window instead and
	// let the ordering pick the winner among the matches.
	const result = await db.query<ProviderConfigRow>(
		`SELECT id, auth_method, encrypted_credential, default_model, metadata, runtime
		 FROM ai_provider_configs
		 WHERE provider = $1::ai_provider AND status = $2
		 ORDER BY is_default DESC, created_at ASC
		 LIMIT ${runtime ? RUNTIME_CANDIDATE_SCAN_LIMIT : 1}`,
		[provider, AiProviderStatus.Verified],
	);

	const rows = result.rows.map((row) => ({
		...row,
		resolvedRuntime: effectiveRuntime(provider, isAgentRuntime(row.runtime) ? row.runtime : null),
	}));
	return (runtime ? rows.find((r) => r.resolvedRuntime === runtime) : rows[0]) ?? null;
}

/**
 * The credential row a run would select, minus the secret. Needs no master key.
 */
export async function selectProviderConfig(
	db: Db,
	provider: AiProvider,
	runtime?: AgentRuntime | null,
): Promise<SelectedProviderConfig | null> {
	const row = await selectProviderConfigRow(db, provider, runtime);
	if (!row) return null;
	return {
		configId: row.id,
		authMethod: row.auth_method,
		defaultModel: row.default_model,
		baseUrl: readConfigBaseUrl(row.metadata),
		runtime: isAgentRuntime(row.runtime) ? row.runtime : null,
		resolvedRuntime: row.resolvedRuntime,
	};
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

/**
 * The current decrypted value of one credential row, or null when the row is
 * gone. For a caller that already chose its config and only needs to know
 * whether the value moved since - a waiter that held a snapshot across a wait
 * during which another execution may have rotated it.
 */
export async function readAiProviderCredentialValue(
	db: Db,
	masterKeyManager: MasterKeyManager,
	configId: string,
): Promise<string | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');
	const result = await db.query<{ encrypted_credential: string }>(
		'SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1',
		[configId],
	);
	const row = result.rows[0];
	return row ? decrypt(row.encrypted_credential, encryptionKey) : null;
}

export async function getProviderCredentialAndModel(
	db: Db,
	masterKeyManager: MasterKeyManager,
	provider: AiProvider,
	/**
	 * Restrict to credentials that run on this CLI. Pass the runtime the run was
	 * resolved to whenever one is known: a provider can hold several credentials
	 * on different CLIs, so selecting by provider alone can return a row whose
	 * runtime disagrees with the one the run is being configured for — which
	 * builds the env for one CLI and launches the other.
	 */
	runtime?: AgentRuntime | null,
): Promise<AiProviderCredentialAndModel | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const row = await selectProviderConfigRow(db, provider, runtime);
	if (!row) return null;

	return {
		configId: row.id,
		value: decrypt(row.encrypted_credential, encryptionKey),
		authMethod: row.auth_method,
		defaultModel: row.default_model,
		baseUrl: readConfigBaseUrl(row.metadata),
		runtime: isAgentRuntime(row.runtime) ? row.runtime : null,
	};
}

/**
 * The public projection of a config row - everything but the encrypted
 * credential. Shared by the list and single-row reads so a create's 201 body and
 * a subsequent list can never disagree about a config's shape.
 */
const CONFIG_COLUMNS = `id, provider, auth_method, label, is_default, status, default_model, metadata, runtime, created_at::text`;

export async function listAiProviders(db: Db): Promise<AiProviderConfig[]> {
	const result = await db.query<AiProviderConfig>(
		`SELECT ${CONFIG_COLUMNS}
		 FROM ai_provider_configs
		 ORDER BY provider ASC, is_default DESC, created_at ASC`,
	);
	return result.rows;
}

export async function getAiProviderConfig(
	db: Db,
	configId: string,
): Promise<AiProviderConfig | null> {
	const result = await db.query<AiProviderConfig>(
		`SELECT ${CONFIG_COLUMNS} FROM ai_provider_configs WHERE id = $1`,
		[configId],
	);
	return result.rows[0] ?? null;
}

export interface AiProviderConfigUpdate {
	label?: string;
	defaultModel?: string | null;
	/**
	 * The CLI this credential runs on. `null` clears the choice back to the
	 * provider default; `undefined` leaves it untouched, per `buildUpdateSet`.
	 */
	runtime?: AgentRuntime | null;
	/**
	 * A replacement credential, encrypted here rather than by the caller so the
	 * plaintext never has to be handed around already-encrypted-or-not.
	 */
	credential?: { value: string; masterKeyManager: MasterKeyManager };
	authMethod?: AiAuthMethod;
	status?: AiProviderStatus;
	/**
	 * Locally-hosted providers only. Merged into the existing jsonb rather than
	 * replacing it, so unrelated metadata keys survive a credential rotation.
	 */
	baseUrl?: string;
}

export async function updateAiProviderConfig(
	db: Db,
	configId: string,
	fields: AiProviderConfigUpdate,
): Promise<boolean> {
	let encryptedCredential: string | undefined;
	if (fields.credential) {
		const encryptionKey = fields.credential.masterKeyManager.getKey();
		if (!encryptionKey) throw new Error('Master key not available');
		encryptedCredential = encrypt(fields.credential.value, encryptionKey);
	}

	const { clauses, params, nextIdx } = buildUpdateSet([
		{ column: 'label', value: fields.label },
		{ column: 'default_model', value: fields.defaultModel },
		{ column: 'runtime', value: fields.runtime, cast: 'agent_runtime' },
		{ column: 'encrypted_credential', value: encryptedCredential },
		{ column: 'auth_method', value: fields.authMethod, cast: 'ai_auth_method' },
		{ column: 'status', value: fields.status },
	]);

	// `buildUpdateSet` can only assign, and the base URL has to merge — overwriting
	// `metadata` wholesale would drop any other key stored alongside it.
	let idx = nextIdx;
	const allParams = [...params];
	if (fields.baseUrl !== undefined) {
		clauses.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${idx}::jsonb`);
		allParams.push(JSON.stringify({ base_url: fields.baseUrl }));
		idx++;
	}

	if (clauses.length === 0) return false;

	const result = await db.query<{ id: string }>(
		`UPDATE ai_provider_configs
		 SET ${clauses.join(', ')}, updated_at = now()
		 WHERE id = $${idx}
		 RETURNING id`,
		[...allParams, configId],
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
