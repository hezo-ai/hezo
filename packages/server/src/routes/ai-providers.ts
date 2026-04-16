import { AI_PROVIDER_INFO, AiAuthMethod, type AiProvider } from '@hezo/shared';
import { Hono } from 'hono';
import { signOAuthState } from '../crypto/state';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import {
	deleteAiProviderConfig,
	getAiProviderStatus,
	listAiProviders,
	setDefaultAiProvider,
	storeAiProviderKey,
} from '../services/ai-provider-keys';

const VALID_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'moonshot']);
const OAUTH_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

export const aiProvidersRoutes = new Hono<Env>();

// List configured AI providers for a company
aiProvidersRoutes.get('/companies/:companyId/ai-providers', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const configs = await listAiProviders(db, access.companyId);
	return ok(c, configs);
});

// Check if any AI provider is configured (lightweight status check)
aiProvidersRoutes.get('/companies/:companyId/ai-providers/status', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const status = await getAiProviderStatus(db, access.companyId);
	return ok(c, status);
});

// Add an AI provider config (manual API key entry)
aiProvidersRoutes.post('/companies/:companyId/ai-providers', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const { companyId } = access;

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

	// Basic format validation
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

	// Validate the key against the provider's API before storing
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
			companyId,
			provider,
			body.api_key,
			authMethod,
			body.label?.trim() || '',
		);

		return ok(c, { id: configId }, 201);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Failed to store AI provider config';
		if (message.includes('unique') || message.includes('duplicate')) {
			return err(c, 'DUPLICATE', 'This provider is already configured with this key', 409);
		}
		return err(c, 'INTERNAL', message, 500);
	}
});

// Delete an AI provider config
aiProvidersRoutes.delete('/companies/:companyId/ai-providers/:configId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const configId = c.req.param('configId');

	const deleted = await deleteAiProviderConfig(db, companyId, configId);
	if (!deleted) {
		return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
	}

	return ok(c, { deleted: true });
});

// Set an AI provider config as default for its provider
aiProvidersRoutes.patch('/companies/:companyId/ai-providers/:configId/default', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const configId = c.req.param('configId');

	const updated = await setDefaultAiProvider(db, companyId, configId);
	if (!updated) {
		return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
	}

	return ok(c, { updated: true });
});

// Start OAuth flow for an AI provider (subscription mode)
aiProvidersRoutes.post('/companies/:companyId/ai-providers/:provider/oauth/start', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const masterKeyManager = c.get('masterKeyManager');
	const connectUrl = c.get('connectUrl');
	const { companyId } = access;
	const provider = c.req.param('provider');

	if (!OAUTH_PROVIDERS.has(provider)) {
		return err(c, 'UNSUPPORTED', `OAuth is not supported for "${provider}"`, 400);
	}

	if (!connectUrl) {
		return err(c, 'CONNECT_UNAVAILABLE', 'Hezo Connect URL is not configured', 503);
	}

	const state = await signOAuthState(
		{ company_id: companyId, ai_provider: provider },
		masterKeyManager,
	);

	const origin = new URL(c.req.url).origin;
	const callbackUrl = `${origin}/oauth/callback`;

	const authUrl = `${connectUrl}/auth/${provider}/start?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;

	return ok(c, { auth_url: authUrl, state });
});

// Verify an AI provider key by making a lightweight API call
aiProvidersRoutes.post('/companies/:companyId/ai-providers/:configId/verify', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const { companyId } = access;
	const configId = c.req.param('configId');

	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) {
		return err(c, 'LOCKED', 'Server must be unlocked', 401);
	}

	// Get the config and decrypt the key
	const result = await db.query<{
		provider: string;
		auth_method: string;
		encrypted_value: string;
	}>(
		`SELECT apc.provider, apc.auth_method, s.encrypted_value
		 FROM ai_provider_configs apc
		 JOIN secrets s ON s.id = apc.api_key_secret_id
		 WHERE apc.id = $1 AND apc.company_id = $2`,
		[configId, companyId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'AI provider config not found', 404);
	}

	const { provider, auth_method } = result.rows[0];
	const { decrypt } = await import('../crypto/encryption');
	const apiKey = decrypt(result.rows[0].encrypted_value, encryptionKey);

	try {
		const valid = await verifyProviderKey(provider as AiProvider, apiKey, auth_method);
		if (valid) {
			return ok(c, { valid: true });
		}
		// Mark as invalid
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
	const endpoints: Record<string, { url: string; headers: Record<string, string> }> = {
		anthropic: {
			url: 'https://api.anthropic.com/v1/models',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
		},
		openai: {
			url: 'https://api.openai.com/v1/models',
			headers: { Authorization: `Bearer ${apiKey}` },
		},
		google: {
			url: `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
			headers: {},
		},
		moonshot: {
			url: 'https://api.moonshot.cn/v1/models',
			headers: { Authorization: `Bearer ${apiKey}` },
		},
	};

	// OAuth tokens can't be verified via API key endpoints
	if (authMethod === AiAuthMethod.OAuthToken) {
		return true; // Trust the OAuth flow
	}

	const config = endpoints[provider];
	if (!config) return false;

	const res = await fetch(config.url, {
		method: 'GET',
		headers: config.headers,
		signal: AbortSignal.timeout(10000),
	});

	return res.ok;
}
