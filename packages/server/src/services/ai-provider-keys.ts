import {
	type AgentRuntime,
	type AiAuthMethod,
	type AiProvider,
	AiProviderStatus,
	effectiveRuntime,
	isAgentRuntime,
	PROVIDER_RUNTIME_ADAPTERS,
	type ProviderAllowance,
} from '@hezo/shared';
import { decrypt, encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { buildUpdateSet, withTransaction } from '../lib/sql';
import { RUNTIME_CANDIDATE_SCAN_LIMIT, resolveRuntimeForTask } from './runtime-resolver';

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
	/** The operator's name for this credential, as a notice names it. */
	label: string;
	authMethod: AiAuthMethod;
	defaultModel: string | null;
	baseUrl: string | null;
	/** The operator's stored CLI choice; null follows the provider default. */
	runtime: AgentRuntime | null;
	/** {@link runtime} resolved against the provider default - the CLI this row runs on. */
	resolvedRuntime: AgentRuntime | null;
	/** When the provider said this credential's spent usage allowance resets, if it is held. */
	usageLimitedUntil: Date | null;
	/** The usage window the provider last reported for this credential, if any. */
	allowance: ProviderAllowance | null;
	/** The admin's daily share of that window; null is the even default. */
	allowanceDailySharePercent: number | null;
}

interface ProviderConfigRow {
	id: string;
	label: string;
	auth_method: AiAuthMethod;
	encrypted_credential: string;
	default_model: string | null;
	metadata: Record<string, unknown> | null;
	runtime: string | null;
	usage_limited_until: Date | string | null;
	allowance_used_percent: number | null;
	allowance_window_minutes: number | null;
	allowance_resets_at: Date | string | null;
	allowance_daily_share_percent: number | null;
}

/** The allowance columns a credential read selects, in one place. */
const ALLOWANCE_COLUMNS_SQL = `allowance_used_percent, allowance_window_minutes, allowance_resets_at,
		        allowance_daily_share_percent`;

/** A credential row's stored usage window, or null when none was ever reported. */
export function rowAllowance(row: {
	allowance_used_percent: number | null;
	allowance_window_minutes: number | null;
	allowance_resets_at: Date | string | null;
}): ProviderAllowance | null {
	if (
		row.allowance_used_percent === null ||
		row.allowance_window_minutes === null ||
		!row.allowance_resets_at
	) {
		return null;
	}
	return {
		usedPercent: Number(row.allowance_used_percent),
		windowMinutes: Number(row.allowance_window_minutes),
		resetsAt: new Date(row.allowance_resets_at),
	};
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
		`SELECT id, label, auth_method, encrypted_credential, default_model, metadata, runtime,
		        usage_limited_until, ${ALLOWANCE_COLUMNS_SQL}
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
		label: row.label,
		authMethod: row.auth_method,
		defaultModel: row.default_model,
		baseUrl: readConfigBaseUrl(row.metadata),
		runtime: isAgentRuntime(row.runtime) ? row.runtime : null,
		resolvedRuntime: row.resolvedRuntime,
		usageLimitedUntil: toDateOrNull(row.usage_limited_until),
		allowance: rowAllowance(row),
		allowanceDailySharePercent:
			row.allowance_daily_share_percent === null ? null : Number(row.allowance_daily_share_percent),
	};
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
	return value ? new Date(value) : null;
}

/** The provider, CLI and credential row a run or chat turn will use. */
export interface RunCredentialSelection {
	provider: AiProvider;
	runtime: AgentRuntime;
	/**
	 * The CLI the credential had to match, or null on the agent-override path,
	 * where the override names only a provider and the credential's own runtime
	 * decides the CLI.
	 */
	requiredRuntime: AgentRuntime | null;
	config: SelectedProviderConfig;
}

/**
 * Resolve what an agent runs on: its own model override when it has one, else
 * the task's runtime pin, else the instance default. The one precedence rule for
 * task runs and chat turns. Needs no master key; the caller decrypts the chosen
 * row by id when it needs the value.
 */
export async function resolveRunCredential(
	db: Db,
	opts: { overrideProvider: AiProvider | null; taskRuntimeType: AgentRuntime | null },
): Promise<({ ok: true } & RunCredentialSelection) | { ok: false; reason: string }> {
	let provider: AiProvider;
	let runtime: AgentRuntime;
	let requiredRuntime: AgentRuntime | null = null;
	if (opts.overrideProvider) {
		provider = opts.overrideProvider;
		const adapter = PROVIDER_RUNTIME_ADAPTERS[provider];
		if (!adapter) {
			return {
				ok: false,
				reason: `This agent's model override references provider "${provider}", which is no longer supported. Clear the override in the agent's settings.`,
			};
		}
		runtime = adapter.runtime;
	} else {
		const resolved = await resolveRuntimeForTask(db, opts.taskRuntimeType);
		if (!resolved.ok) return resolved;
		provider = resolved.provider;
		runtime = resolved.runtime;
		requiredRuntime = resolved.runtime;
	}

	const config = await selectProviderConfig(db, provider, requiredRuntime);
	if (!config) {
		return {
			ok: false,
			reason: `No ${provider} credential configured. Add one in Settings > AI Providers.`,
		};
	}
	if (!requiredRuntime) runtime = effectiveRuntime(provider, config.runtime) ?? runtime;
	return { ok: true, provider, runtime, requiredRuntime, config };
}

/**
 * Hold a credential until its spent usage allowance resets. Returns whether no
 * hold stood before, so the caller tells a person once per outage rather than
 * once per refused run. Writes nothing when the stored time already matches.
 */
export async function recordUsageHold(db: Db, configId: string, until: Date): Promise<boolean> {
	const r = await db.query<{ started: boolean }>(
		`UPDATE ai_provider_configs c
		    SET usage_limited_until = $2
		   FROM (SELECT usage_limited_until AS prev FROM ai_provider_configs WHERE id = $1) p
		  WHERE c.id = $1 AND c.usage_limited_until IS DISTINCT FROM $2
		 RETURNING p.prev IS NULL AS started`,
		[configId, until],
	);
	return r.rows[0]?.started === true;
}

/**
 * Read a credential's hold against the database clock, and when it has lapsed,
 * move it forward by `probeMinutes` for this caller alone.
 *
 * `claimed` is true for the one caller that moved it. `active` says the hold read
 * before any move was still in force. Both are judged on the database clock, the
 * same clock the wakeup scan reads, so a server clock that drifts from it cannot
 * release a wakeup that the hold then sends straight back.
 */
export async function readOrClaimUsageHold(
	db: Db,
	configId: string,
	probeMinutes: number,
): Promise<{ until: Date | null; active: boolean; claimed: boolean }> {
	const r = await db.query<{
		until: Date | string | null;
		active: boolean;
		claimed: boolean;
	}>(
		`WITH prior AS (
		   SELECT usage_limited_until AS until, usage_limited_until > now() AS active
		     FROM ai_provider_configs WHERE id = $1
		 ), claimed AS (
		   UPDATE ai_provider_configs
		      SET usage_limited_until = now() + make_interval(mins => $2::int)
		    WHERE id = $1 AND usage_limited_until <= now()
		   RETURNING id
		 )
		 SELECT (SELECT until FROM prior) AS until,
		        COALESCE((SELECT active FROM prior), false) AS active,
		        EXISTS (SELECT 1 FROM claimed) AS claimed`,
		[configId, probeMinutes],
	);
	const row = r.rows[0];
	return {
		until: toDateOrNull(row?.until),
		active: row?.active === true,
		claimed: row?.claimed === true,
	};
}

/** A credential's hold while it is still in force on the database clock, else null. */
export async function readActiveUsageHold(db: Db, configId: string): Promise<Date | null> {
	const r = await db.query<{ usage_limited_until: Date | string | null }>(
		`SELECT usage_limited_until FROM ai_provider_configs
		  WHERE id = $1 AND usage_limited_until > now()`,
		[configId],
	);
	return toDateOrNull(r.rows[0]?.usage_limited_until);
}

/**
 * Store the usage window a run just read for its credential. Writes nothing when
 * the report matches what is stored, so a run polling every minute writes only
 * when the provider's figure moved. `allowance_seen_at` moves with a write, and
 * says when the stored figure was last true.
 */
export async function recordCredentialAllowance(
	db: Db,
	configId: string,
	allowance: ProviderAllowance,
): Promise<void> {
	await db.query(
		`UPDATE ai_provider_configs
		    SET allowance_used_percent = $2, allowance_window_minutes = $3,
		        allowance_resets_at = $4, allowance_seen_at = now()
		  WHERE id = $1
		    AND (allowance_used_percent IS DISTINCT FROM $2::real
		      OR allowance_window_minutes IS DISTINCT FROM $3::int
		      OR allowance_resets_at IS DISTINCT FROM $4::timestamptz)`,
		[configId, allowance.usedPercent, allowance.windowMinutes, allowance.resetsAt],
	);
}

/** Remove a credential's hold. Returns whether there was one to remove. */
export async function clearUsageHold(db: Db, configId: string): Promise<boolean> {
	const r = await db.query<{ id: string }>(
		`UPDATE ai_provider_configs SET usage_limited_until = NULL
		  WHERE id = $1 AND usage_limited_until IS NOT NULL
		 RETURNING id`,
		[configId],
	);
	return r.rows.length > 0;
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
 * Advance a stored credential to `newValue` only if it still holds `expectedValue`.
 *
 * For a rotated-credential read-back taken without a whole-run lock: two runs
 * sharing one credential can each rotate the same starting token to a different
 * (still valid) successor. This moves the store forward only from the value the
 * caller started on, so a run that finished on a now-superseded token drops its
 * write instead of moving the store back to a sibling. The row is locked for the
 * compare so two write-backs cannot both read the same "before". Returns whether
 * it wrote. The ciphertext carries a random IV, so the compare is on the
 * decrypted value, not the stored bytes.
 */
export async function casUpdateAiProviderCredential(
	db: Db,
	masterKeyManager: MasterKeyManager,
	configId: string,
	expectedValue: string,
	newValue: string,
): Promise<boolean> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');
	return withTransaction(db, async () => {
		const current = await db.query<{ encrypted_credential: string }>(
			'SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1 FOR UPDATE',
			[configId],
		);
		const row = current.rows[0];
		if (!row) return false;
		if (decrypt(row.encrypted_credential, encryptionKey) !== expectedValue) return false;
		await db.query(
			'UPDATE ai_provider_configs SET encrypted_credential = $1, updated_at = now() WHERE id = $2',
			[encrypt(newValue, encryptionKey), configId],
		);
		return true;
	});
}

/**
 * Mark a config `invalid`, but only while it still holds the credential the
 * caller proved dead.
 *
 * The compare is the whole point. A run condemns the credential it *ran on*, and
 * that run may have started minutes before the operator pasted a replacement -
 * so writing on the config id alone would mark a brand-new credential invalid on
 * the strength of a dead one's failure, and the operator would watch a key they
 * had just fixed go red for no reason they could see. Same
 * lock-then-decrypt-compare as {@link casUpdateAiProviderCredential}, whose
 * reasoning about the random IV applies here unchanged.
 *
 * The status guard keeps a repeat condemnation from rewriting a row that already
 * says what it needs to: the embedded database does not vacuum, so a no-op
 * update is leaked storage, and a burst of runs all failing on one dead token is
 * exactly when that would happen. Returns whether it wrote.
 */
export async function casMarkAiProviderInvalid(
	db: Db,
	masterKeyManager: MasterKeyManager,
	configId: string,
	expectedValue: string,
): Promise<boolean> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');
	return withTransaction(db, async () => {
		const current = await db.query<{ encrypted_credential: string; status: string }>(
			'SELECT encrypted_credential, status FROM ai_provider_configs WHERE id = $1 FOR UPDATE',
			[configId],
		);
		const row = current.rows[0];
		if (!row) return false;
		if (row.status === AiProviderStatus.Invalid) return false;
		if (decrypt(row.encrypted_credential, encryptionKey) !== expectedValue) return false;
		await db.query('UPDATE ai_provider_configs SET status = $1, updated_at = now() WHERE id = $2', [
			AiProviderStatus.Invalid,
			configId,
		]);
		return true;
	});
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
		// A replacement credential is a different allowance, so it starts unheld.
		{ column: 'usage_limited_until', value: encryptedCredential === undefined ? undefined : null },
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

/**
 * Delete a config, handing the instance-wide default on when the deleted row
 * held it.
 *
 * Without the hand-on, deleting the default leaves the instance with no
 * designated credential at all. Nothing fails loudly - `resolveRuntimeForTask`
 * falls through to its "no default designated" branch and picks the oldest
 * verified row - so runs keep working while the settings page shows no Default
 * on any row, and the operator's next deliberate choice is made against a
 * designation that quietly stopped existing.
 *
 * **The successor is a verified row wherever one exists.** A designated default
 * that cannot run is not a fallback the resolver forgives: it refuses the run
 * naming that credential rather than passing to the next in line. So promoting a
 * rejected row over a working one would take an instance that still had a usable
 * credential and stop it dead. Only when nothing is verified does the oldest
 * remaining row take it, which leaves the resolver able to name the credential
 * the operator has to fix instead of reporting that none is configured.
 *
 * Ordering matches `selectProviderConfigRow` and the resolver - oldest first,
 * `id` breaking a same-millisecond tie - so the row promoted here is the one a
 * run would have chosen anyway. The whole thing is one transaction: the partial
 * unique index permits a single default, and a delete that committed without its
 * successor would leave exactly the state this exists to prevent.
 */
export async function deleteAiProviderConfig(db: Db, configId: string): Promise<boolean> {
	return withTransaction(db, async () => {
		const result = await db.query<{ id: string; is_default: boolean }>(
			`DELETE FROM ai_provider_configs WHERE id = $1 RETURNING id, is_default`,
			[configId],
		);
		const deleted = result.rows[0];
		if (!deleted) return false;
		if (!deleted.is_default) return true;

		const successor = await db.query<{ id: string }>(
			`SELECT id FROM ai_provider_configs
			 ORDER BY (status = $1) DESC, created_at ASC, id ASC
			 LIMIT 1`,
			[AiProviderStatus.Verified],
		);
		const promote = successor.rows[0];
		if (promote) {
			await db.query(
				`UPDATE ai_provider_configs SET is_default = true, updated_at = now() WHERE id = $1`,
				[promote.id],
			);
		}
		return true;
	});
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

/**
 * Whether the operator has set an AI provider up, and which of them can run.
 *
 * **The two are deliberately different questions**, because one consumer gates
 * the whole app on the first. `configured` asks whether setup has been done at
 * all - any row, whatever its status - and `providers` asks which providers a
 * run could actually use, which is the verified ones.
 *
 * Answering `configured` from the verified rows is what made a rejected
 * credential look like a fresh install: the first-run wizard replaces the entire
 * app shell while `configured` is false, so an operator who pressed Verify on a
 * credential the provider refused was thrown out of Settings and into onboarding -
 * away from the one screen where the credential could be replaced, and reading as
 * though their instance had lost its setup.
 */
export async function getAiProviderStatus(
	db: Db,
): Promise<{ configured: boolean; providers: string[] }> {
	const result = await db.query<{ provider: string; status: string }>(
		`SELECT DISTINCT provider, status FROM ai_provider_configs`,
	);

	// A provider holding both a verified and a rejected credential comes back on
	// two rows, so the usable list is de-duplicated rather than taken as-is.
	const verified = new Set(
		result.rows.filter((r) => r.status === AiProviderStatus.Verified).map((r) => r.provider),
	);
	return { configured: result.rows.length > 0, providers: [...verified] };
}

export async function getProviderConfigCredential(
	db: Db,
	masterKeyManager: MasterKeyManager,
	configId: string,
): Promise<{
	provider: string;
	authMethod: AiAuthMethod;
	value: string;
	baseUrl: string | null;
} | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const result = await db.query<{
		provider: string;
		auth_method: AiAuthMethod;
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
