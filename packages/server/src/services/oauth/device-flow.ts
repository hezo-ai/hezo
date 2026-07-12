import type { DeviceAuthConfig } from '@hezo/shared';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DeviceFlowStart {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	interval: number;
}

export interface DeviceFlowPollPending {
	status: 'pending';
	retryAfter: number;
}

export interface DeviceFlowPollSuccess {
	status: 'success';
	accessToken: string;
	scope: string;
	/**
	 * Durable refresh token, when the provider issues one (Google's device-flow
	 * client does; GitHub's does not). Kept host-side; never surfaced to a run.
	 */
	refreshToken?: string | null;
	/** Absolute access-token expiry, derived from the provider's `expires_in`. */
	expiresAt?: Date | null;
}

export interface DeviceFlowPollFailure {
	status: 'failed';
	error: string;
}

export type DeviceFlowPollResult =
	| DeviceFlowPollPending
	| DeviceFlowPollSuccess
	| DeviceFlowPollFailure;

export interface ResolvedDeviceAuth {
	deviceCodeUrl: string;
	tokenUrl: string;
	clientId: string;
}

/**
 * Resolve a capability's static {@link DeviceAuthConfig} into concrete runtime
 * values: apply the optional base-URL origin override (tests / self-hosted
 * Enterprise) and pick the client_id from the env var, falling back to the
 * committed public dev client_id outside production. Throws when no client_id
 * is configured so the failure is explicit rather than a silent empty request.
 */
export function resolveDeviceAuth(cfg: DeviceAuthConfig): ResolvedDeviceAuth {
	const baseOverride = cfg.baseUrlEnv ? process.env[cfg.baseUrlEnv] : undefined;
	const applyBase = (url: string): string =>
		baseOverride ? new URL(new URL(url).pathname, baseOverride).toString() : url;

	const clientId =
		process.env[cfg.clientIdEnv] ||
		(process.env.NODE_ENV === 'production' ? '' : (cfg.clientIdDefault ?? ''));
	if (!clientId) {
		throw new Error(`no OAuth client_id configured (set ${cfg.clientIdEnv})`);
	}

	return {
		deviceCodeUrl: applyBase(cfg.deviceCodeUrl),
		tokenUrl: applyBase(cfg.tokenUrl),
		clientId,
	};
}

/**
 * Begin the device flow: request a device + user code for the given scopes. The
 * user enters the user code at the returned verification URI; the caller then
 * polls {@link pollDeviceFlow} until authorization completes.
 */
export async function startDeviceFlow(opts: {
	deviceCodeUrl: string;
	clientId: string;
	scopes: string[];
	fetchFn?: FetchFn;
}): Promise<DeviceFlowStart> {
	const fetchFn = opts.fetchFn ?? globalThis.fetch;
	const body = new URLSearchParams({ client_id: opts.clientId, scope: opts.scopes.join(' ') });

	const res = await fetchFn(opts.deviceCodeUrl, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`device-code request failed (${res.status}): ${text}`);
	}
	const data = (await res.json()) as {
		device_code: string;
		user_code: string;
		// RFC 8628 names the field `verification_uri`; Google's device endpoint
		// predates the RFC and sends `verification_url` instead.
		verification_uri?: string;
		verification_url?: string;
		expires_in: number;
		interval: number;
	};
	const verificationUri = data.verification_uri || data.verification_url;
	if (!data.device_code || !data.user_code || !verificationUri) {
		throw new Error('device-code response is missing device_code, user_code, or verification_uri');
	}
	return {
		deviceCode: data.device_code,
		userCode: data.user_code,
		verificationUri,
		expiresIn: data.expires_in,
		interval: data.interval,
	};
}

/**
 * Poll the device-flow token endpoint once. Returns `pending` (keep polling
 * after `retryAfter` seconds), `success` (with the access token), or `failed`.
 */
export async function pollDeviceFlow(opts: {
	tokenUrl: string;
	clientId: string;
	deviceCode: string;
	/**
	 * Confidential-client secret, when the provider's device-flow client requires
	 * it in the token poll (Google's "TVs and Limited Input devices" client does).
	 * Omitted for public clients like GitHub.
	 */
	clientSecret?: string;
	fetchFn?: FetchFn;
}): Promise<DeviceFlowPollResult> {
	const fetchFn = opts.fetchFn ?? globalThis.fetch;
	const body = new URLSearchParams({
		client_id: opts.clientId,
		device_code: opts.deviceCode,
		grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
	});
	if (opts.clientSecret) body.set('client_secret', opts.clientSecret);

	const res = await fetchFn(opts.tokenUrl, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	const data = (await res.json()) as {
		access_token?: string;
		scope?: string;
		error?: string;
		interval?: number;
		refresh_token?: string;
		expires_in?: number;
	};
	if (data.error === 'authorization_pending' || data.error === 'slow_down') {
		return { status: 'pending', retryAfter: data.interval ?? 5 };
	}
	if (data.access_token) {
		return {
			status: 'success',
			accessToken: data.access_token,
			scope: data.scope ?? '',
			refreshToken: data.refresh_token ?? null,
			expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
		};
	}
	return { status: 'failed', error: data.error ?? 'unknown_error' };
}
