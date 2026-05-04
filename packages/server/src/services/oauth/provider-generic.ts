import { logger } from '../../logger';

const log = logger.child('oauth-generic');

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OAuthMetadata {
	issuer?: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
	code_challenge_methods_supported?: string[];
	resource_documentation?: string;
}

export interface AuthCodeStartInput {
	authorizeUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
	state: string;
	codeChallenge: string;
	resource?: string;
	additionalParams?: Record<string, string>;
}

export interface ExchangeCodeInput {
	tokenUrl: string;
	clientId: string;
	clientSecret?: string;
	code: string;
	codeVerifier: string;
	redirectUri: string;
	additionalParams?: Record<string, string>;
}

export interface TokenResponse {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: Date | null;
	scope?: string;
	tokenType?: string;
	raw: Record<string, unknown>;
}

/**
 * Discover an OAuth provider's authorization metadata per the OAuth 2.0
 * Authorization Server Metadata RFC (8414) and the MCP authorization
 * spec. Tries `<base>/.well-known/oauth-authorization-server` first, then
 * `<base>/.well-known/openid-configuration` as a fallback.
 *
 * `resourceUrl` is the MCP server's URL (or any base URL we want to discover
 * metadata for); we strip the path and probe the root.
 */
export async function discoverMetadata(
	resourceUrl: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<OAuthMetadata> {
	const u = new URL(resourceUrl);
	const base = `${u.protocol}//${u.host}`;
	const candidates = [
		`${base}/.well-known/oauth-authorization-server`,
		`${base}/.well-known/openid-configuration`,
	];
	let lastError: string | null = null;
	for (const url of candidates) {
		try {
			const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
			if (!res.ok) {
				lastError = `${url} → ${res.status}`;
				continue;
			}
			const data = (await res.json()) as OAuthMetadata;
			if (!data.authorization_endpoint || !data.token_endpoint) {
				lastError = `${url} → missing required endpoints`;
				continue;
			}
			return data;
		} catch (e) {
			lastError = `${url} → ${(e as Error).message}`;
		}
	}
	throw new Error(`OAuth metadata discovery failed: ${lastError ?? 'no candidates responded'}`);
}

export function buildAuthorizationUrl(input: AuthCodeStartInput): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: input.clientId,
		redirect_uri: input.redirectUri,
		state: input.state,
		code_challenge: input.codeChallenge,
		code_challenge_method: 'S256',
		scope: input.scopes.join(' '),
	});
	if (input.resource) params.set('resource', input.resource);
	if (input.additionalParams) {
		for (const [k, v] of Object.entries(input.additionalParams)) {
			params.set(k, v);
		}
	}
	const sep = input.authorizeUrl.includes('?') ? '&' : '?';
	return `${input.authorizeUrl}${sep}${params.toString()}`;
}

export async function exchangeCode(
	input: ExchangeCodeInput,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<TokenResponse> {
	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		code: input.code,
		redirect_uri: input.redirectUri,
		client_id: input.clientId,
		code_verifier: input.codeVerifier,
	});
	if (input.clientSecret) params.set('client_secret', input.clientSecret);
	if (input.additionalParams) {
		for (const [k, v] of Object.entries(input.additionalParams)) {
			params.set(k, v);
		}
	}

	const res = await fetchFn(input.tokenUrl, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params,
	});
	const text = await res.text();
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text) as Record<string, unknown>;
	} catch {
		raw = parseUrlEncoded(text);
	}
	if (!res.ok) {
		const errorCode = typeof raw.error === 'string' ? raw.error : `${res.status}`;
		const description = typeof raw.error_description === 'string' ? raw.error_description : '';
		throw new Error(`token endpoint error: ${errorCode}${description ? ` — ${description}` : ''}`);
	}
	const accessToken = typeof raw.access_token === 'string' ? raw.access_token : null;
	if (!accessToken) {
		log.warn('token response missing access_token', { keys: Object.keys(raw) });
		throw new Error('token endpoint response missing access_token');
	}
	const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : null;
	const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
	return {
		accessToken,
		refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : null,
		expiresAt,
		scope: typeof raw.scope === 'string' ? raw.scope : undefined,
		tokenType: typeof raw.token_type === 'string' ? raw.token_type : undefined,
		raw,
	};
}

function parseUrlEncoded(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const sp = new URLSearchParams(text);
	for (const [k, v] of sp.entries()) out[k] = v;
	return out;
}
