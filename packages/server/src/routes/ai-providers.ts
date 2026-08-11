import {
	type AgentRuntime,
	AI_PROVIDER_INFO,
	AiAuthMethod,
	type AiProvider,
	AiProviderStatus,
	ALL_AI_PROVIDERS,
	isAgentRuntime,
	parseProviderModels,
	providerRuntimes,
	providerSupportsRuntime,
} from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { isUniqueViolation } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireAdminEquivalent } from '../middleware/auth';
import {
	deleteAiProviderConfig,
	getAiProviderStatus,
	getProviderConfigCredential,
	listAiProviders,
	readConfigBaseUrl,
	setDefaultAiProvider,
	storeAiProviderKey,
	updateAiProviderConfig,
} from '../services/ai-provider-keys';
import { getPinnedModel, refreshModelPins } from '../services/model-pins';
import { fetchProviderCatalog, probeProviderCatalog } from '../services/provider-catalog';
import { validateSubscriptionBlob } from '../services/subscription-auth';

const log = logger.child('routes');

const VALID_PROVIDERS = new Set<string>(ALL_AI_PROVIDERS);

type RuntimeChoice = { ok: true; value: AgentRuntime | null } | { ok: false; error: string };

/**
 * Validate an operator-supplied CLI choice against the provider's own roster.
 * Null and undefined both mean "follow the provider default" and are always
 * accepted, so a client that has never heard of the field keeps working.
 *
 * Rejecting an unsupported pairing here is what keeps an unrunnable credential
 * out of the database: the column is a bare enum (which pairings are valid is a
 * TypeScript table that moves when a provider gains a CLI), so this route is the
 * only place the two are checked against each other.
 */
function parseRuntimeChoice(provider: AiProvider, raw: unknown): RuntimeChoice {
	if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
	if (!isAgentRuntime(raw)) {
		return { ok: false, error: `Unknown runtime "${String(raw)}"` };
	}
	if (!providerSupportsRuntime(provider, raw)) {
		return {
			ok: false,
			error: `${AI_PROVIDER_INFO[provider]?.name ?? provider} cannot run on "${raw}". Supported: ${providerRuntimes(provider).join(', ')}`,
		};
	}
	return { ok: true, value: raw };
}

type CredentialPrep =
	| { ok: true; value: string; baseUrl: string | null }
	| { ok: false; code: string; message: string; status: 400 | 503 };

/**
 * Normalize a locally-hosted runner's server URL. Shared by the credential
 * preparation below and the update route, which can change the URL on its own
 * without a new credential.
 */
function parseServerUrl(raw: string): { ok: true; value: string } | { ok: false; message: string } {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return { ok: false, message: 'Server URL must be a valid URL' };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { ok: false, message: 'Server URL must use http or https' };
	}
	return { ok: true, value: raw.replace(/\/+$/, '') };
}

/**
 * Validate an operator-supplied credential against its provider and return the
 * value to store, plus the normalized base URL for a locally-hosted runner.
 *
 * Shared by the create route and the credential-rotation half of the update
 * route, so a replacement key is held to exactly the same bar as a new one —
 * format, subscription-blob shape, and a live call to the provider — rather than
 * being written unchecked and only failing at run time.
 */
async function prepareProviderCredential(
	provider: AiProvider,
	authMethod: AiAuthMethod,
	rawKey: string | undefined,
	rawBaseUrl: string | undefined,
): Promise<CredentialPrep> {
	const info = AI_PROVIDER_INFO[provider];

	// A locally-hosted runner authenticates only if the operator turned auth on, so
	// the key is optional here; `encrypted_credential` is NOT NULL, so an omitted
	// one is stored as the runner's documented sentinel. Its endpoint is
	// per-install, so the base URL takes the place of the key as the required field.
	let baseUrl: string | null = null;
	let value: string;
	if (info?.local) {
		const parsed = parseServerUrl(rawBaseUrl?.trim() || info.local.defaultBaseUrl);
		if (!parsed.ok) {
			return { ok: false, code: 'INVALID_BASE_URL', message: parsed.message, status: 400 };
		}
		baseUrl = parsed.value;
		value = rawKey?.trim() || info.local.authTokenSentinel;
	} else {
		if (!rawKey?.trim()) {
			return { ok: false, code: 'INVALID_REQUEST', message: 'api_key is required', status: 400 };
		}
		value = rawKey;
	}

	if (authMethod === AiAuthMethod.Subscription) {
		if (!info.supportsSubscription) {
			return {
				ok: false,
				code: 'UNSUPPORTED_AUTH_METHOD',
				message: `${info.name} does not support subscription auth — use an API key instead`,
				status: 400,
			};
		}
		const validation = validateSubscriptionBlob(provider, value);
		if (!validation.ok) {
			return {
				ok: false,
				code: 'INVALID_SUBSCRIPTION_BLOB',
				message: validation.error ?? 'Invalid credential',
				status: 400,
			};
		}
	}

	if (info.keyPrefix && authMethod === AiAuthMethod.ApiKey && !value.startsWith(info.keyPrefix)) {
		return {
			ok: false,
			code: 'INVALID_KEY_FORMAT',
			message: `API key for ${info.name} should start with "${info.keyPrefix}"`,
			status: 400,
		};
	}

	if (authMethod === AiAuthMethod.ApiKey && !process.env.SKIP_AI_KEY_VALIDATION) {
		const probe = await probeProviderCatalog(provider, value, baseUrl);
		// "We could not ask" is not "your key is wrong", and the difference is the
		// whole diagnosis for a local runner that simply is not running. Keep the
		// two apart: only a provider that answered and refused blames the key.
		if (!probe.ok && probe.reason === 'unreachable') {
			return {
				ok: false,
				code: 'VALIDATION_FAILED',
				message: info.local
					? `Could not reach ${info.name} at ${baseUrl}. Check the server is running and the URL is reachable from Hezo.`
					: 'Could not reach the provider to validate the key. Please try again.',
				status: 503,
			};
		}
		if (!probe.ok) {
			return {
				ok: false,
				code: 'INVALID_KEY',
				message: `API key validation failed — the key was rejected by ${info.name}`,
				status: 400,
			};
		}
	}

	return { ok: true, value, baseUrl };
}

export const aiProvidersRoutes = new Hono<Env>();

// List configured AI providers (instance-wide)
aiProvidersRoutes.get('/ai-providers', async (c) => {
	const db = c.get('db');
	const configs = await listAiProviders(db);
	return ok(c, configs);
});

// Check if any AI provider is configured (lightweight status check)
aiProvidersRoutes.get('/ai-providers/status', async (c) => {
	const db = c.get('db');
	const status = await getAiProviderStatus(db);
	return ok(c, status);
});

// Add an AI provider config (manual API key entry)
aiProvidersRoutes.post('/ai-providers', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	const body = await c.req.json<{
		provider: string;
		api_key: string;
		label?: string;
		auth_method?: string;
		base_url?: string;
		runtime?: string | null;
	}>();

	if (!body.provider || !VALID_PROVIDERS.has(body.provider)) {
		return err(
			c,
			'INVALID_PROVIDER',
			`Provider must be one of: ${[...VALID_PROVIDERS].join(', ')}`,
			400,
		);
	}

	const key = masterKeyManager.getKey();
	if (!key) {
		return err(c, 'LOCKED', 'Server must be unlocked to manage AI providers', 401);
	}

	const provider = body.provider as AiProvider;
	const authMethod = (body.auth_method as AiAuthMethod) || AiAuthMethod.ApiKey;

	const runtimeChoice = parseRuntimeChoice(provider, body.runtime);
	if (!runtimeChoice.ok) {
		return err(c, 'INVALID_RUNTIME', runtimeChoice.error, 400);
	}

	const prepared = await prepareProviderCredential(
		provider,
		authMethod,
		body.api_key,
		body.base_url,
	);
	if (!prepared.ok) {
		return err(c, prepared.code, prepared.message, prepared.status);
	}

	try {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			provider,
			prepared.value,
			authMethod,
			body.label?.trim(),
			prepared.baseUrl ? { base_url: prepared.baseUrl } : {},
			runtimeChoice.value,
		);

		// A new credential starts on the provider's pinned model rather than on
		// "none". Only ever here, on creation: an existing config's model is the
		// operator's choice and no refresh may move it (see services/model-pins).
		// A subscription picks its own model inside the CLI, so it gets none.
		if (authMethod !== AiAuthMethod.Subscription) {
			const pinned = await getPinnedModel(db, provider);
			if (pinned) {
				await updateAiProviderConfig(db, configId, { defaultModel: pinned });
			}
		}

		return ok(c, { id: configId }, 201);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Failed to store AI provider config';
		if (message.includes('unique') || message.includes('duplicate')) {
			return err(c, 'DUPLICATE', 'A config with this provider and label already exists', 409);
		}
		return err(c, 'INTERNAL', message, 500);
	}
});

// Re-read every configured provider's catalog and move its pinned default model
// to the newest in that provider's family. The same pass the daily cron runs,
// exposed so an operator does not have to wait a day after a provider ships a
// generation. Existing configs keep their model; only the default a NEW
// credential starts on moves.
aiProvidersRoutes.post('/ai-providers/refresh-model-pins', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const result = await refreshModelPins(c.get('db'), c.get('masterKeyManager'));
	return ok(c, result);
});

// Delete an AI provider config
aiProvidersRoutes.delete('/ai-providers/:configId', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const configId = c.req.param('configId');

	const deleted = await deleteAiProviderConfig(db, configId);
	if (!deleted) {
		return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
	}

	return ok(c, { deleted: true });
});

// Set an AI provider config as default for its provider
aiProvidersRoutes.patch('/ai-providers/:configId/default', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const configId = c.req.param('configId');

	const updated = await setDefaultAiProvider(db, configId);
	if (!updated) {
		return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
	}

	return ok(c, { updated: true });
});

// Verify an AI provider key by making a lightweight API call
aiProvidersRoutes.post('/ai-providers/:configId/verify', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const configId = c.req.param('configId');

	if (!masterKeyManager.getKey()) {
		return err(c, 'LOCKED', 'Server must be unlocked', 401);
	}

	const cred = await getProviderConfigCredential(db, masterKeyManager, configId);
	if (!cred) {
		return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
	}

	try {
		// A subscription blob is not an API key any catalog endpoint accepts, so it
		// is taken as verified rather than probed - the same rule the create path
		// applies, kept in step with it here.
		const probe =
			cred.authMethod === AiAuthMethod.Subscription
				? ({ ok: true } as const)
				: await probeProviderCatalog(cred.provider as AiProvider, cred.value, cred.baseUrl);
		if (probe.ok) {
			// Persist the healthy state so the badge is truthful and a key that was
			// previously marked `invalid` recovers on a successful re-verify.
			await db.query(
				`UPDATE ai_provider_configs SET status = $1, updated_at = now() WHERE id = $2`,
				[AiProviderStatus.Verified, configId],
			);
			return ok(c, { valid: true });
		}
		// An unreachable provider says nothing about the key, so the stored status
		// is left alone rather than being marked invalid on a network blip - a
		// badge that flips to "invalid" because the operator's laptop was offline
		// is worse than no badge.
		if (probe.reason === 'unreachable') {
			return ok(c, { valid: false, message: 'Could not reach provider to verify key' });
		}
		await db.query(`UPDATE ai_provider_configs SET status = $1, updated_at = now() WHERE id = $2`, [
			AiProviderStatus.Invalid,
			configId,
		]);
		return ok(c, { valid: false, message: 'API key is invalid or expired' });
	} catch {
		return ok(c, { valid: false, message: 'Could not reach provider to verify key' });
	}
});

// Update a provider config — `label` (rename), `default_model`, `runtime` (the CLI
// this credential runs on; null clears it back to the provider default), and/or a
// replacement credential (`api_key`, with `auth_method`/`base_url` alongside it).
//
// The settings Edit dialog saves all of these in one submit, so they land in one
// request and one UPDATE: there is no window where the key rotated but the rename
// failed. An absent or blank `api_key` leaves the stored credential untouched.
aiProvidersRoutes.patch('/ai-providers/:configId', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const configId = c.req.param('configId');

	const body = await c.req.json<{
		default_model?: string | null;
		label?: string;
		runtime?: string | null;
		api_key?: string;
		auth_method?: string;
		base_url?: string;
	}>();
	const hasLabel = 'label' in body;
	const hasModel = 'default_model' in body;
	const hasRuntime = 'runtime' in body;
	// A blank key is the dialog's "leave the credential alone" state, not a request
	// to store an empty one — treat it as absent rather than rejecting the save.
	const hasCredential = Boolean(body.api_key?.trim());
	// A local runner's server URL is editable on its own: it is the field most
	// likely to change (a moved port, a new host) and needs no new credential.
	const hasBaseUrl = Boolean(body.base_url?.trim());
	if (!hasLabel && !hasModel && !hasRuntime && !hasCredential && !hasBaseUrl) {
		return err(c, 'INVALID_REQUEST', 'Nothing to update', 400);
	}

	const label = hasLabel && typeof body.label === 'string' ? body.label.trim() : '';
	if (hasLabel && !label) {
		return err(c, 'INVALID_REQUEST', 'label must be a non-empty string', 400);
	}

	const model =
		body.default_model === null || body.default_model === undefined
			? null
			: typeof body.default_model === 'string'
				? body.default_model.trim() || null
				: null;

	// The CLI choice and the credential are both only meaningful against this
	// config's own provider, which the request doesn't carry — read the row once and
	// serve both, so an unsupported pairing or a malformed key 404s or 400s here
	// rather than being written and failing at run time.
	let owner: { provider: AiProvider; auth_method: AiAuthMethod; metadata: unknown } | undefined;
	if (hasRuntime || hasCredential || hasBaseUrl) {
		const result = await db.query<{
			provider: AiProvider;
			auth_method: AiAuthMethod;
			metadata: Record<string, unknown> | null;
		}>(`SELECT provider, auth_method, metadata FROM ai_provider_configs WHERE id = $1`, [configId]);
		owner = result.rows[0];
		if (!owner) {
			return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
		}
	}

	let runtime: AgentRuntime | null = null;
	if (hasRuntime && owner) {
		const parsed = parseRuntimeChoice(owner.provider, body.runtime);
		if (!parsed.ok) {
			return err(c, 'INVALID_RUNTIME', parsed.error, 400);
		}
		runtime = parsed.value;
	}

	// A base URL only means anything to a locally-hosted runner; every hosted
	// provider has a fixed endpoint, so the field is ignored there exactly as the
	// create route ignores it.
	let baseUrl: string | undefined;
	if (hasBaseUrl && owner && AI_PROVIDER_INFO[owner.provider]?.local) {
		const parsed = parseServerUrl((body.base_url as string).trim());
		if (!parsed.ok) {
			return err(c, 'INVALID_BASE_URL', parsed.message, 400);
		}
		baseUrl = parsed.value;
	}

	let credential: { value: string; authMethod: AiAuthMethod } | null = null;
	if (hasCredential && owner) {
		// Only the credential half needs the master key — a rename must keep working
		// on a locked instance, as it always has.
		if (!masterKeyManager.getKey()) {
			return err(c, 'LOCKED', 'Server must be unlocked to manage AI providers', 401);
		}
		const authMethod = (body.auth_method as AiAuthMethod) || owner.auth_method;
		const prepared = await prepareProviderCredential(
			owner.provider,
			authMethod,
			body.api_key,
			baseUrl ?? readConfigBaseUrl(owner.metadata) ?? undefined,
		);
		if (!prepared.ok) {
			return err(c, prepared.code, prepared.message, prepared.status);
		}
		credential = { value: prepared.value, authMethod };
		if (prepared.baseUrl) baseUrl = prepared.baseUrl;
	}

	try {
		const updated = await updateAiProviderConfig(db, configId, {
			...(hasLabel ? { label } : {}),
			...(hasModel ? { defaultModel: model } : {}),
			...(hasRuntime ? { runtime } : {}),
			...(baseUrl ? { baseUrl } : {}),
			...(credential
				? {
						credential: { value: credential.value, masterKeyManager },
						authMethod: credential.authMethod,
						// `prepareProviderCredential` has just live-verified the key, so a config
						// previously marked `invalid` becomes selectable again in the same write
						// rather than needing a separate Verify click.
						status: AiProviderStatus.Verified,
					}
				: {}),
		});
		if (!updated) {
			return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
		}
	} catch (e) {
		if (isUniqueViolation(e)) {
			return err(c, 'DUPLICATE', 'A config with this provider and label already exists', 409);
		}
		throw e;
	}

	// Nothing derived from the credential goes back over the wire — not a prefix,
	// a length, or a masked form.
	return ok(c, {
		updated: true,
		...(hasLabel ? { label } : {}),
		...(hasModel ? { default_model: model } : {}),
		...(hasRuntime ? { runtime } : {}),
		...(credential ? { credential_updated: true } : {}),
	});
});

// List models available for this provider config, fetched live from the provider
aiProvidersRoutes.get('/ai-providers/:configId/models', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const configId = c.req.param('configId');

	if (!masterKeyManager.getKey()) {
		return err(c, 'LOCKED', 'Server must be unlocked', 401);
	}

	const cred = await getProviderConfigCredential(db, masterKeyManager, configId);
	if (!cred) {
		return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
	}

	const provider = cred.provider as AiProvider;

	// Subscription sign-in stores an OAuth/CLI blob, not an API key the catalog
	// endpoint accepts — a live listing call would only 401. Signal the caller to
	// fall back to the CLI's default model instead of surfacing a spurious error.
	if (cred.authMethod === AiAuthMethod.Subscription) {
		return err(
			c,
			'SUBSCRIPTION_UNSUPPORTED',
			'Model listing is unavailable for subscription sign-in; the CLI default model is used',
			400,
		);
	}

	const catalog = await fetchProviderCatalog(provider, cred.value, cred.baseUrl);
	if (!catalog.ok) {
		if (catalog.reason === 'unsupported') {
			return err(c, 'UNSUPPORTED', `No models endpoint for provider "${provider}"`, 400);
		}
		if (catalog.reason === 'unreachable') {
			return err(c, 'PROVIDER_UNREACHABLE', 'Could not reach provider to list models', 503);
		}
		if (catalog.reason === 'rejected') {
			return err(c, 'INVALID_KEY', 'Provider rejected the stored credential', 401);
		}
		return err(
			c,
			'PROVIDER_ERROR',
			catalog.status
				? `Provider returned status ${catalog.status}`
				: 'Provider returned unparseable response',
			503,
		);
	}

	const models = parseProviderModels(provider, catalog.json);
	return ok(c, models);
});
