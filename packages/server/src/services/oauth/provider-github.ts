import { logger } from '../../logger';

const log = logger.child('oauth-github');

const DEFAULT_OAUTH_BASE_URL = 'https://github.com';
const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_CLIENT_ID = 'Iv23liQrFTunw0NJYzbR';
const DEFAULT_SCOPES = ['repo', 'workflow', 'read:org'];

export function getOAuthBaseUrl(): string {
	return process.env.GITHUB_OAUTH_BASE_URL || DEFAULT_OAUTH_BASE_URL;
}

export function getApiBaseUrl(): string {
	return process.env.GITHUB_API_BASE_URL || DEFAULT_API_BASE_URL;
}

export function getClientId(): string {
	return process.env.GITHUB_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;
}

export function defaultGitHubScopes(): string[] {
	return [...DEFAULT_SCOPES];
}

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
}

export interface DeviceFlowPollFailure {
	status: 'failed';
	error: string;
}

export type DeviceFlowPollResult =
	| DeviceFlowPollPending
	| DeviceFlowPollSuccess
	| DeviceFlowPollFailure;

export interface GitHubAccount {
	id: number;
	login: string;
	avatarUrl: string;
	email: string | null;
}

export interface RegisteredSigningKey {
	id: number;
	title: string;
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function startDeviceFlow(
	opts: { scopes?: string[]; clientId?: string; fetchFn?: FetchFn } = {},
): Promise<DeviceFlowStart> {
	const fetchFn = opts.fetchFn ?? globalThis.fetch;
	const scopes = (opts.scopes ?? defaultGitHubScopes()).join(' ');
	const clientId = opts.clientId ?? getClientId();

	const body = new URLSearchParams({ client_id: clientId, scope: scopes });
	const res = await fetchFn(`${getOAuthBaseUrl()}/login/device/code`, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub device-code request failed (${res.status}): ${text}`);
	}
	const data = (await res.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		expires_in: number;
		interval: number;
	};
	return {
		deviceCode: data.device_code,
		userCode: data.user_code,
		verificationUri: data.verification_uri,
		expiresIn: data.expires_in,
		interval: data.interval,
	};
}

export async function pollDeviceFlow(
	deviceCode: string,
	opts: { clientId?: string; fetchFn?: FetchFn } = {},
): Promise<DeviceFlowPollResult> {
	const fetchFn = opts.fetchFn ?? globalThis.fetch;
	const clientId = opts.clientId ?? getClientId();

	const body = new URLSearchParams({
		client_id: clientId,
		device_code: deviceCode,
		grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
	});
	const res = await fetchFn(`${getOAuthBaseUrl()}/login/oauth/access_token`, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	const data = (await res.json()) as {
		access_token?: string;
		scope?: string;
		error?: string;
		interval?: number;
	};
	if (data.error === 'authorization_pending' || data.error === 'slow_down') {
		return { status: 'pending', retryAfter: data.interval ?? 5 };
	}
	if (data.access_token) {
		return { status: 'success', accessToken: data.access_token, scope: data.scope ?? '' };
	}
	return { status: 'failed', error: data.error ?? 'unknown_error' };
}

export async function fetchAccount(
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<GitHubAccount> {
	const res = await fetchFn(`${getApiBaseUrl()}/user`, {
		headers: authHeaders(accessToken),
	});
	if (!res.ok) {
		throw new Error(`GitHub /user failed (${res.status})`);
	}
	const data = (await res.json()) as {
		id: number;
		login: string;
		avatar_url?: string;
		email?: string | null;
	};
	return {
		id: data.id,
		login: data.login,
		avatarUrl: data.avatar_url ?? '',
		email: data.email ?? null,
	};
}

export async function registerSigningKey(
	accessToken: string,
	publicKey: string,
	title: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<RegisteredSigningKey> {
	const res = await fetchFn(`${getApiBaseUrl()}/user/ssh_signing_keys`, {
		method: 'POST',
		headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, key: publicKey }),
	});
	if (!res.ok) {
		const text = await res.text();
		log.warn('failed to register signing key on GitHub', { status: res.status, body: text });
		throw new Error(`GitHub /user/ssh_signing_keys failed (${res.status}): ${text}`);
	}
	const data = (await res.json()) as { id: number; title: string };
	return { id: data.id, title: data.title };
}

function authHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'User-Agent': 'Hezo/1.0',
	};
}
