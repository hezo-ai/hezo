import {
	AI_PROVIDER_INFO,
	AiAuthMethod,
	type AiProvider,
	ALL_AI_PROVIDERS,
	OAUTH_AI_PROVIDERS,
	OAUTH_CALLBACK_PATH,
} from '@hezo/shared';
import { Hono } from 'hono';
import { signOAuthState } from '../crypto/state';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import {
	deleteAiProviderConfig,
	getAiProviderStatus,
	getProviderConfigCredential,
	listAiProviders,
	setDefaultAiProvider,
	storeAiProviderKey,
} from '../services/ai-provider-keys';

const VALID_PROVIDERS = new Set<string>(ALL_AI_PROVIDERS);
const OAUTH_PROVIDERS = new Set<string>(OAUTH_AI_PROVIDERS);

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
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	const body = await c.req.json<{
		provider: string;
		api_key: string;
		label?: string;
		auth_method?: string;
	}>();

	if (!body.provider || !VALID_PROVIDERS.has(body.provider)) {
		return err(
			c,
			'INVALID_PROVIDER',
			`Provider must be one of: ${[...VALID_PROVIDERS].join(', ')}`,
			400,
		);
	}

	if (!body.api_key?.trim()) {
		return err(c, 'INVALID_REQUEST', 'api_key is required', 400);
	}

	const key = masterKeyManager.getKey();
	if (!key) {
		return err(c, 'LOCKED', 'Server must be unlocked to manage AI providers', 401);
	}

	const provider = body.provider as AiProvider;
	const authMethod = (body.auth_method as AiAuthMethod) || AiAuthMethod.ApiKey;

	const info = AI_PROVIDER_INFO[provider];
	if (
		info.keyPrefix &&
		authMethod === AiAuthMethod.ApiKey &&
		!body.api_key.startsWith(info.keyPrefix)
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
			const valid = await verifyProviderKey(provider, body.api_key, authMethod);
			if (!valid) {
				return err(
					c,
					'INVALID_KEY',
					`API key validation failed — the key was rejected by ${info.name}`,
					400,
				);
			}
		} catch {
			return err(
				c,
				'VALIDATION_FAILED',
				'Could not reach the provider to validate the key. Please try again.',
				503,
			);
		}
	}

	try {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			provider,
			body.api_key,
			authMethod,
			body.label?.trim(),
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
	const denied = requireSuperuser(c);
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
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const db = c.get('db');
	const configId = c.req.param('configId');

	const updated = await setDefaultAiProvider(db, configId);
	if (!updated) {
		return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
	}

	return ok(c, { updated: true });
});

// Start OAuth flow for an AI provider (subscription mode)
aiProvidersRoutes.post('/ai-providers/:provider/oauth/start', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const masterKeyManager = c.get('masterKeyManager');
	const connectUrl = c.get('connectUrl');
	const provider = c.req.param('provider');

	if (!OAUTH_PROVIDERS.has(provider)) {
		return err(c, 'UNSUPPORTED', `OAuth is not supported for "${provider}"`, 400);
	}

	if (!connectUrl) {
		return err(c, 'CONNECT_UNAVAILABLE', 'Hezo Connect URL is not configured', 503);
	}

	const state = await signOAuthState({ ai_provider: provider }, masterKeyManager);

	const origin = new URL(c.req.url).origin;
	const callbackUrl = `${origin}${OAUTH_CALLBACK_PATH}`;

	const authUrl = `${connectUrl}/auth/${provider}/start?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;

	return ok(c, { auth_url: authUrl, state });
});

// Verify an AI provider key by making a lightweight API call
aiProvidersRoutes.post('/ai-providers/:configId/verify', async (c) => {
	const denied = requireSuperuser(c);
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
		const valid = await verifyProviderKey(cred.provider as AiProvider, cred.value, cred.authMethod);
		if (valid) {
			return ok(c, { valid: true });
		}
		await db.query(
			`UPDATE ai_provider_configs SET status = 'invalid', updated_at = now() WHERE id = $1`,
			[configId],
		);
		return ok(c, { valid: false, message: 'API key is invalid or expired' });
	} catch {
		return ok(c, { valid: false, message: 'Could not reach provider to verify key' });
	}
});

async function verifyProviderKey(
	provider: AiProvider,
	apiKey: string,
	authMethod: string,
): Promise<boolean> {
	if (authMethod === AiAuthMethod.OAuthToken) return true;

	const endpoint = AI_PROVIDER_INFO[provider]?.verifyEndpoint;
	if (!endpoint) return false;

	const url = typeof endpoint.url === 'function' ? endpoint.url(apiKey) : endpoint.url;
	const headers =
		typeof endpoint.headers === 'function' ? endpoint.headers(apiKey) : endpoint.headers;

	const res = await fetch(url, {
		method: 'GET',
		headers,
		signal: AbortSignal.timeout(10000),
	});

	return res.ok;
}
