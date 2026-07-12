import {
	type ConnectorRegistry,
	type OAuthProvider,
	resolveConnectorRegistry,
} from '../connector-registry';

/**
 * Body of the broker `oauth-device/start` request. A `provider_id` picks a
 * bundled registry descriptor (Google/YouTube, GitHub, …) as the default set of
 * endpoints/scopes/hosts; each BYO field overrides the descriptor. With no
 * `provider_id` the caller supplies every endpoint directly ("Custom").
 */
export interface BrokerStartBody {
	provider_id?: string;
	client_id?: string;
	client_secret?: string;
	device_code_url?: string;
	token_url?: string;
	scopes?: string[];
	allowed_hosts?: string[];
}

export interface BrokerDescriptor {
	deviceCodeUrl: string;
	tokenUrl: string;
	scopes: string[];
	allowedHosts: string[];
	clientId: string;
	/** Present only for a confidential client (Google). Host-only; never surfaced. */
	clientSecret?: string;
	/** Registry provider id, or `oauth-broker` for a custom (BYO-endpoint) flow. */
	provider: string;
}

export type ResolveBrokerResult =
	| { ok: true; descriptor: BrokerDescriptor }
	| { ok: false; error: string };

/**
 * Pure, unit-testable resolver for the generic OAuth device-flow broker. Resolves
 * a `provider_id` to its bundled descriptor, then layers any BYO body fields on
 * top (each overrides the descriptor default). Requires a `client_id` and a
 * final `device_code_url` + `token_url` (from the descriptor or the body).
 */
export function resolveBrokerDescriptor(
	body: BrokerStartBody,
	registry: ConnectorRegistry = resolveConnectorRegistry(),
): ResolveBrokerResult {
	let provider: OAuthProvider | undefined;
	if (body.provider_id) {
		provider = registry.oauthProviders.find((p) => p.id === body.provider_id);
		if (!provider) return { ok: false, error: `unknown provider_id: ${body.provider_id}` };
	}

	const clientId = body.client_id?.trim();
	if (!clientId) return { ok: false, error: 'client_id is required' };

	// Start from the descriptor's endpoints; each BYO body field overrides.
	const deviceCodeUrl = body.device_code_url?.trim() || provider?.device_code_url || '';
	const tokenUrl = body.token_url?.trim() || provider?.token_url || '';
	if (!deviceCodeUrl) {
		return { ok: false, error: 'device_code_url is required (no provider default)' };
	}
	if (!tokenUrl) {
		return { ok: false, error: 'token_url is required (no provider default)' };
	}

	const scopes = body.scopes && body.scopes.length > 0 ? body.scopes : (provider?.scopes ?? []);
	const allowedHosts =
		body.allowed_hosts && body.allowed_hosts.length > 0
			? body.allowed_hosts
			: (provider?.allowed_hosts ?? []);

	return {
		ok: true,
		descriptor: {
			deviceCodeUrl,
			tokenUrl,
			scopes,
			allowedHosts,
			clientId,
			clientSecret: body.client_secret?.trim() || undefined,
			provider: body.provider_id ?? 'oauth-broker',
		},
	};
}
