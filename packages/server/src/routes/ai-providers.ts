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
	setDefaultAiProvider,
	storeAiProviderKey,
	updateAiProviderConfig,
} from '../services/ai-provider-keys';
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

	const info = AI_PROVIDER_INFO[provider];

	const runtimeChoice = parseRuntimeChoice(provider, body.runtime);
	if (!runtimeChoice.ok) {
		return err(c, 'INVALID_RUNTIME', runtimeChoice.error, 400);
	}

	// A locally-hosted runner authenticates only if the operator turned auth on, so
	// the key is optional here; `encrypted_credential` is NOT NULL, so an omitted
	// one is stored as the runner's documented sentinel. Its endpoint is
	// per-install, so the base URL takes the place of the key as the required field.
	let baseUrl: string | null = null;
	if (info?.local) {
		const raw = body.base_url?.trim() || info.local.defaultBaseUrl;
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			return err(c, 'INVALID_BASE_URL', 'Server URL must be a valid URL', 400);
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return err(c, 'INVALID_BASE_URL', 'Server URL must use http or https', 400);
		}
		baseUrl = raw.replace(/\/+$/, '');
	} else if (!body.api_key?.trim()) {
		return err(c, 'INVALID_REQUEST', 'api_key is required', 400);
	}

	const credentialValue = info?.local
		? body.api_key?.trim() || info.local.authTokenSentinel
		: body.api_key;

	if (authMethod === AiAuthMethod.Subscription) {
		if (!info.supportsSubscription) {
			return err(
				c,
				'UNSUPPORTED_AUTH_METHOD',
				`${info.name} does not support subscription auth — use an API key instead`,
				400,
			);
		}
		const validation = validateSubscriptionBlob(provider, body.api_key);
		if (!validation.ok) {
			return err(c, 'INVALID_SUBSCRIPTION_BLOB', validation.error ?? 'Invalid credential', 400);
		}
	}

	if (
		info.keyPrefix &&
		authMethod === AiAuthMethod.ApiKey &&
		!credentialValue.startsWith(info.keyPrefix)
	) {
		return err(
			c,
			'INVALID_KEY_FORMAT',
			`API key for ${info.name} should start with "${info.keyPrefix}"`,
			400,
		);
	}

	if (authMethod === AiAuthMethod.ApiKey && !process.env.SKIP_AI_KEY_VALIDATION) {
		try {
			const valid = await verifyProviderKey(provider, credentialValue, authMethod, baseUrl);
			if (!valid) {
				return err(
					c,
					'INVALID_KEY',
					`API key validation failed — the key was rejected by ${info.name}`,
					400,
				);
			}
		} catch {
			// For a local provider the usual cause is that the runner is not listening
			// at the given URL, so name the endpoint rather than blaming a key that
			// may not even be required.
			return err(
				c,
				'VALIDATION_FAILED',
				info.local
					? `Could not reach ${info.name} at ${baseUrl}. Check the server is running and the URL is reachable from Hezo.`
					: 'Could not reach the provider to validate the key. Please try again.',
				503,
			);
		}
	}

	try {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			provider,
			credentialValue,
			authMethod,
			body.label?.trim(),
			baseUrl ? { base_url: baseUrl } : {},
			runtimeChoice.value,
		);

		return ok(c, { id: configId }, 201);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Failed to store AI provider config';
		if (message.includes('unique') || message.includes('duplicate')) {
			return err(c, 'DUPLICATE', 'A config with this provider and label already exists', 409);
		}
		return err(c, 'INTERNAL', message, 500);
	}
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
		const valid = await verifyProviderKey(
			cred.provider as AiProvider,
			cred.value,
			cred.authMethod,
			cred.baseUrl,
		);
		if (valid) {
			// Persist the healthy state so the badge is truthful and a key that was
			// previously marked `invalid` recovers on a successful re-verify.
			await db.query(
				`UPDATE ai_provider_configs SET status = $1, updated_at = now() WHERE id = $2`,
				[AiProviderStatus.Verified, configId],
			);
			return ok(c, { valid: true });
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

// Update a provider config — `label` (rename), `default_model`, and/or `runtime`
// (the CLI this credential runs on; null clears it back to the provider default)
aiProvidersRoutes.patch('/ai-providers/:configId', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const configId = c.req.param('configId');

	const body = await c.req.json<{
		default_model?: string | null;
		label?: string;
		runtime?: string | null;
	}>();
	const hasLabel = 'label' in body;
	const hasModel = 'default_model' in body;
	const hasRuntime = 'runtime' in body;
	if (!hasLabel && !hasModel && !hasRuntime) {
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

	// The CLI choice is only meaningful against this config's own provider, which
	// the request doesn't carry — read it first so an unsupported pairing 404s or
	// 400s here rather than being written and failing at run time.
	let runtime: AgentRuntime | null = null;
	if (hasRuntime) {
		const owner = await db.query<{ provider: AiProvider }>(
			`SELECT provider FROM ai_provider_configs WHERE id = $1`,
			[configId],
		);
		const ownerProvider = owner.rows[0]?.provider;
		if (!ownerProvider) {
			return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
		}
		const parsed = parseRuntimeChoice(ownerProvider, body.runtime);
		if (!parsed.ok) {
			return err(c, 'INVALID_RUNTIME', parsed.error, 400);
		}
		runtime = parsed.value;
	}

	try {
		const updated = await updateAiProviderConfig(db, configId, {
			...(hasLabel ? { label } : {}),
			...(hasModel ? { defaultModel: model } : {}),
			...(hasRuntime ? { runtime } : {}),
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

	return ok(c, {
		updated: true,
		...(hasLabel ? { label } : {}),
		...(hasModel ? { default_model: model } : {}),
		...(hasRuntime ? { runtime } : {}),
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

	const endpoint = resolveCatalogEndpoint(provider, cred.value, cred.baseUrl);
	if (!endpoint) {
		return err(c, 'UNSUPPORTED', `No models endpoint for provider "${provider}"`, 400);
	}

	let res: Response;
	try {
		res = await fetch(endpoint.url, {
			method: 'GET',
			headers: endpoint.headers,
			signal: AbortSignal.timeout(10000),
		});
	} catch {
		// For a local provider this is the expected error when the operator's server
		// simply is not running, which is exactly what PROVIDER_UNREACHABLE conveys.
		return err(c, 'PROVIDER_UNREACHABLE', 'Could not reach provider to list models', 503);
	}

	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			return err(c, 'INVALID_KEY', 'Provider rejected the stored credential', 401);
		}
		return err(c, 'PROVIDER_ERROR', `Provider returned status ${res.status}`, 503);
	}

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		return err(c, 'PROVIDER_ERROR', 'Provider returned unparseable response', 503);
	}

	const models = parseProviderModels(provider, json);
	return ok(c, models);
});

/**
 * Resolve the catalog endpoint used both to verify a credential and to list a
 * provider's models. Hosted providers use their fixed `verifyEndpoint`; a
 * locally-hosted one (Ollama, LM Studio) has no fixed endpoint, so the URL is
 * built from the operator's configured base URL, falling back to the runner's
 * documented default port. Both runners expose the OpenAI-shaped `/v1/models`,
 * which `parseProviderModels` already handles via its generic `data[]` branch.
 */
function resolveCatalogEndpoint(
	provider: AiProvider,
	apiKey: string,
	baseUrl?: string | null,
): { url: string; headers: Record<string, string> } | null {
	const info = AI_PROVIDER_INFO[provider];
	if (!info) return null;

	if (info.local) {
		const root = (baseUrl?.trim() || info.local.defaultBaseUrl).replace(/\/+$/, '');
		return {
			url: `${root}/v1/models`,
			headers: { Authorization: `Bearer ${apiKey}` },
		};
	}

	const endpoint = info.verifyEndpoint;
	if (!endpoint) return null;
	return {
		url: typeof endpoint.url === 'function' ? endpoint.url(apiKey) : endpoint.url,
		headers: typeof endpoint.headers === 'function' ? endpoint.headers(apiKey) : endpoint.headers,
	};
}

async function verifyProviderKey(
	provider: AiProvider,
	apiKey: string,
	authMethod: string,
	baseUrl?: string | null,
): Promise<boolean> {
	if (authMethod === AiAuthMethod.Subscription) return true;

	const endpoint = resolveCatalogEndpoint(provider, apiKey, baseUrl);
	if (!endpoint) return false;

	const res = await fetch(endpoint.url, {
		method: 'GET',
		headers: endpoint.headers,
		signal: AbortSignal.timeout(10000),
	});

	return res.ok;
}
