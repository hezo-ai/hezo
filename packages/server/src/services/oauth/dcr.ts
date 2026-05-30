import { logger } from '../../logger';
import type { FetchFn } from './provider-generic';

const log = logger.child('oauth-dcr');

export interface DcrRequest {
	registrationEndpoint: string;
	redirectUri: string;
	clientName?: string;
	scope?: string;
	additionalParams?: Record<string, unknown>;
}

export interface DcrResult {
	clientId: string;
	clientSecret?: string;
	registrationAccessToken?: string;
	registrationClientUri?: string;
	clientIdIssuedAt?: number;
	clientSecretExpiresAt?: number;
	raw: Record<string, unknown>;
}

/**
 * Dynamic Client Registration (RFC 7591) — register this Hezo instance as a
 * public OAuth client at the provider's Authorization Server with our own
 * callback URL. Returns the issued client_id (and optional registration
 * access token for future updates/revocation).
 *
 * Always requests `token_endpoint_auth_method: 'none'` (public client +
 * PKCE), per the architectural decision in the connector plan.
 */
export async function registerClient(
	input: DcrRequest,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<DcrResult> {
	const body: Record<string, unknown> = {
		redirect_uris: [input.redirectUri],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web',
		...(input.clientName ? { client_name: input.clientName } : {}),
		...(input.scope ? { scope: input.scope } : {}),
		...(input.additionalParams ?? {}),
	};

	const res = await fetchFn(input.registrationEndpoint, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	const text = await res.text();
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text) as Record<string, unknown>;
	} catch {
		raw = {};
	}

	if (!res.ok) {
		const errorCode = typeof raw.error === 'string' ? raw.error : `${res.status}`;
		const description = typeof raw.error_description === 'string' ? raw.error_description : '';
		throw new Error(
			`DCR registration failed at ${input.registrationEndpoint}: ${errorCode}${
				description ? ` — ${description}` : ''
			}`,
		);
	}

	const clientId = typeof raw.client_id === 'string' ? raw.client_id : null;
	if (!clientId) {
		log.warn('DCR response missing client_id', { keys: Object.keys(raw) });
		throw new Error('DCR response missing client_id');
	}

	return {
		clientId,
		clientSecret: typeof raw.client_secret === 'string' ? raw.client_secret : undefined,
		registrationAccessToken:
			typeof raw.registration_access_token === 'string' ? raw.registration_access_token : undefined,
		registrationClientUri:
			typeof raw.registration_client_uri === 'string' ? raw.registration_client_uri : undefined,
		clientIdIssuedAt:
			typeof raw.client_id_issued_at === 'number' ? raw.client_id_issued_at : undefined,
		clientSecretExpiresAt:
			typeof raw.client_secret_expires_at === 'number' ? raw.client_secret_expires_at : undefined,
		raw,
	};
}
