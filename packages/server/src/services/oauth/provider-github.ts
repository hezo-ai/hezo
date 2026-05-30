import { logger } from '../../logger';

const log = logger.child('oauth-github');

const DEFAULT_API_BASE_URL = 'https://api.github.com';
// Mirrors the `github` capability registry entry — the union of scopes the
// REST helpers need to register SSH keys, list orgs/repos, and create repos.
const REQUIRED_REPO_SETUP_SCOPES = ['repo', 'read:org', 'write:public_key'];

export function getApiBaseUrl(): string {
	return process.env.GITHUB_API_BASE_URL || DEFAULT_API_BASE_URL;
}

export function requiredRepoSetupScopes(): string[] {
	return [...REQUIRED_REPO_SETUP_SCOPES];
}

export function computeScopeStatus(have: string[] | null | undefined): {
	sufficient: boolean;
	missing: string[];
	required: string[];
} {
	const required = requiredRepoSetupScopes();
	const haveSet = new Set(have ?? []);
	const missing = required.filter((s) => !haveSet.has(s));
	return { sufficient: missing.length === 0, missing, required };
}

export interface GitHubAccount {
	id: number;
	login: string;
	avatarUrl: string;
	email: string | null;
}

export type SigningKeyResult =
	| { status: 'created'; id: number; title: string }
	| { status: 'already_exists' };

export type AuthKeyResult =
	| { status: 'created'; id: number; title: string }
	| { status: 'already_exists' };

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
): Promise<SigningKeyResult> {
	const res = await fetchFn(`${getApiBaseUrl()}/user/ssh_signing_keys`, {
		method: 'POST',
		headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, key: publicKey }),
	});
	if (!res.ok) {
		const text = await res.text();
		if (res.status === 422 && isKeyAlreadyInUse(text)) {
			log.info('signing key already registered on GitHub, no-op');
			return { status: 'already_exists' };
		}
		log.warn('failed to register signing key on GitHub', { status: res.status, body: text });
		throw new Error(`GitHub /user/ssh_signing_keys failed (${res.status}): ${text}`);
	}
	const data = (await res.json()) as { id: number; title: string };
	return { status: 'created', id: data.id, title: data.title };
}

export async function registerAuthKey(
	accessToken: string,
	publicKey: string,
	title: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<AuthKeyResult> {
	const res = await fetchFn(`${getApiBaseUrl()}/user/keys`, {
		method: 'POST',
		headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, key: publicKey }),
	});
	if (!res.ok) {
		const text = await res.text();
		if (res.status === 422 && isKeyAlreadyInUse(text)) {
			log.info('auth key already registered on GitHub, no-op');
			return { status: 'already_exists' };
		}
		log.warn('failed to register auth key on GitHub', { status: res.status, body: text });
		throw new Error(`GitHub /user/keys failed (${res.status}): ${text}`);
	}
	const data = (await res.json()) as { id: number; title: string };
	return { status: 'created', id: data.id, title: data.title };
}

function isKeyAlreadyInUse(body: string): boolean {
	try {
		const parsed = JSON.parse(body) as {
			errors?: Array<{ message?: string }>;
		};
		return (parsed.errors ?? []).some((e) => /key is already in use/i.test(e.message ?? ''));
	} catch {
		return /key is already in use/i.test(body);
	}
}

function authHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'User-Agent': 'Hezo/1.0',
	};
}
