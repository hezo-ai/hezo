import { Hono } from 'hono';
import type { ConnectConfig } from '../config.js';
import {
	createNonce,
	type NonceStore,
	type StatePayload,
	signState,
	verifyState,
} from '../crypto/state.js';
import type { TokenCodeStore } from '../crypto/token-store.js';
import * as anthropicProvider from '../providers/anthropic.js';
import * as githubProvider from '../providers/github.js';
import * as googleProvider from '../providers/google.js';
import * as openaiProvider from '../providers/openai.js';

export type FetchFn = typeof globalThis.fetch;

interface ProviderDefinition {
	authUrl: string;
	scopes: string;
	exchangeCode: (
		code: string,
		clientId: string,
		clientSecret: string,
		redirectUri: string,
		fetchFn: FetchFn,
	) => Promise<{ access_token: string; scope: string }>;
	// biome-ignore lint/suspicious/noExplicitAny: provider user info types vary
	fetchUserInfo: (accessToken: string, fetchFn: FetchFn) => Promise<any>;
	// biome-ignore lint/suspicious/noExplicitAny: provider user info types vary
	buildMetadata: (userInfo: any) => string;
}

const PROVIDER_REGISTRY: Record<string, ProviderDefinition> = {
	github: {
		authUrl: 'https://github.com/login/oauth/authorize',
		scopes: 'repo,workflow,read:org',
		exchangeCode: githubProvider.exchangeCode,
		fetchUserInfo: githubProvider.fetchUserInfo,
		buildMetadata: (userInfo) => {
			const info = userInfo as { login: string; avatar_url: string; email: string | null };
			return Buffer.from(
				JSON.stringify({
					username: info.login,
					avatar_url: info.avatar_url,
					email: info.email,
				}),
			).toString('base64url');
		},
	},
	anthropic: {
		authUrl: 'https://console.anthropic.com/oauth/authorize',
		scopes: 'openid profile email',
		exchangeCode: anthropicProvider.exchangeCode,
		fetchUserInfo: anthropicProvider.fetchUserInfo,
		buildMetadata: (userInfo) => {
			const info = userInfo as { email: string; name: string };
			return Buffer.from(
				JSON.stringify({
					email: info.email,
					name: info.name,
				}),
			).toString('base64url');
		},
	},
	openai: {
		authUrl: 'https://auth.openai.com/authorize',
		scopes: 'openid profile email',
		exchangeCode: openaiProvider.exchangeCode,
		fetchUserInfo: openaiProvider.fetchUserInfo,
		buildMetadata: (userInfo) => {
			const info = userInfo as { email: string; name: string };
			return Buffer.from(
				JSON.stringify({
					email: info.email,
					name: info.name,
				}),
			).toString('base64url');
		},
	},
	google: {
		authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: 'openid email profile https://www.googleapis.com/auth/generative-language',
		exchangeCode: googleProvider.exchangeCode,
		fetchUserInfo: googleProvider.fetchUserInfo,
		buildMetadata: (userInfo) => {
			const info = userInfo as { email: string; name: string };
			return Buffer.from(
				JSON.stringify({
					email: info.email,
					name: info.name,
				}),
			).toString('base64url');
		},
	},
};

const SUPPORTED_PLATFORMS = new Set(Object.keys(PROVIDER_REGISTRY));

function errorRedirect(
	callbackUrl: string,
	platform: string,
	errorCode: string,
	message?: string,
): string {
	const url = new URL(callbackUrl);
	url.searchParams.set('error', errorCode);
	url.searchParams.set('platform', platform);
	if (message) url.searchParams.set('message', message);
	return url.toString();
}

export function oauthRoutes(
	config: ConnectConfig,
	nonceStore: NonceStore,
	tokenCodeStore: TokenCodeStore,
	fetchFn: FetchFn = globalThis.fetch,
): Hono {
	const routes = new Hono();

	routes.get('/auth/:platform/start', (c) => {
		const platform = c.req.param('platform');

		if (!SUPPORTED_PLATFORMS.has(platform)) {
			return c.json(
				{ error: 'unsupported_platform', message: `Platform "${platform}" is not supported` },
				400,
			);
		}

		const callbackUrl = c.req.query('callback');
		if (!callbackUrl) {
			return c.json(
				{ error: 'missing_callback', message: 'callback query parameter is required' },
				400,
			);
		}

		const providerConfig = config[platform as keyof ConnectConfig] as
			| { clientId: string; clientSecret: string }
			| undefined;

		if (!providerConfig) {
			return c.redirect(
				errorRedirect(
					callbackUrl,
					platform,
					'missing_config',
					`${platform} OAuth is not configured`,
				),
			);
		}

		const provider = PROVIDER_REGISTRY[platform];

		const nonce = createNonce();
		nonceStore.add(nonce);

		const payload: StatePayload = {
			callback_url: callbackUrl,
			platform,
			nonce,
			timestamp: new Date().toISOString(),
		};

		const originalState = c.req.query('state');
		if (originalState) payload.original_state = originalState;

		const signedState = signState(payload, config.statePrivateKey);

		const connectCallbackUrl = new URL(c.req.url);
		connectCallbackUrl.pathname = `/auth/${platform}/callback`;
		connectCallbackUrl.search = '';

		const authUrl = new URL(provider.authUrl);
		authUrl.searchParams.set('client_id', providerConfig.clientId);
		authUrl.searchParams.set('redirect_uri', connectCallbackUrl.toString());
		authUrl.searchParams.set('scope', provider.scopes);
		authUrl.searchParams.set('state', signedState);

		// Google requires response_type parameter
		if (platform === 'google') {
			authUrl.searchParams.set('response_type', 'code');
		}

		return c.redirect(authUrl.toString());
	});

	routes.get('/auth/:platform/callback', async (c) => {
		const platform = c.req.param('platform');
		const code = c.req.query('code');
		const stateParam = c.req.query('state');

		if (!SUPPORTED_PLATFORMS.has(platform)) {
			return c.json(
				{ error: 'unsupported_platform', message: `Platform "${platform}" is not supported` },
				400,
			);
		}

		if (!stateParam) {
			return c.json({ error: 'invalid_state', message: 'Missing state parameter' }, 400);
		}

		const payload = verifyState(stateParam, config.statePublicKey);
		if (!payload) {
			return c.json({ error: 'invalid_state', message: 'Invalid state signature' }, 400);
		}

		const callbackUrl = payload.callback_url;

		if (!nonceStore.consume(payload.nonce)) {
			return c.redirect(
				errorRedirect(callbackUrl, platform, 'expired_nonce', 'Nonce expired or already used'),
			);
		}

		if (c.req.query('error') === 'access_denied') {
			return c.redirect(
				errorRedirect(callbackUrl, platform, 'access_denied', 'User denied authorization'),
			);
		}

		if (!code) {
			return c.redirect(
				errorRedirect(callbackUrl, platform, 'invalid_state', 'Missing authorization code'),
			);
		}

		const providerConfig = config[platform as keyof ConnectConfig] as
			| { clientId: string; clientSecret: string }
			| undefined;

		if (!providerConfig) {
			return c.redirect(
				errorRedirect(
					callbackUrl,
					platform,
					'missing_config',
					`${platform} OAuth is not configured`,
				),
			);
		}

		const provider = PROVIDER_REGISTRY[platform];

		const connectCallbackUrl = new URL(c.req.url);
		connectCallbackUrl.search = '';

		try {
			const tokenResponse = await provider.exchangeCode(
				code,
				providerConfig.clientId,
				providerConfig.clientSecret,
				connectCallbackUrl.toString(),
				fetchFn,
			);

			const userInfo = await provider.fetchUserInfo(tokenResponse.access_token, fetchFn);

			const metadata = provider.buildMetadata(userInfo);

			// Store token server-side and redirect with a short-lived one-time code
			const tokenCode = tokenCodeStore.store({
				accessToken: tokenResponse.access_token,
				scopes: tokenResponse.scope,
				metadata,
				platform,
			});

			const redirectUrl = new URL(callbackUrl);
			redirectUrl.searchParams.set('platform', platform);
			redirectUrl.searchParams.set('code', tokenCode);
			if (payload.original_state) {
				redirectUrl.searchParams.set('state', payload.original_state);
			}

			return c.redirect(redirectUrl.toString());
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Token exchange failed';
			return c.redirect(errorRedirect(callbackUrl, platform, 'token_exchange_failed', message));
		}
	});

	// Token exchange endpoint: server exchanges a one-time code for the actual token
	routes.post('/auth/exchange', async (c) => {
		const body = await c.req.json<{ code: string }>();
		if (!body.code) {
			return c.json({ error: 'missing_code', message: 'code is required' }, 400);
		}

		const token = tokenCodeStore.consume(body.code);
		if (!token) {
			return c.json({ error: 'invalid_code', message: 'Code is invalid or expired' }, 400);
		}

		return c.json({
			access_token: token.accessToken,
			scopes: token.scopes,
			metadata: token.metadata,
			platform: token.platform,
		});
	});

	return routes;
}
