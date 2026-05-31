import { logger } from '../logger';

const log = logger.child('github');

const DEFAULT_API_BASE_URL = 'https://api.github.com';

export function getApiBaseUrl(): string {
	return process.env.GITHUB_API_BASE_URL || DEFAULT_API_BASE_URL;
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RepoAccessResult {
	accessible: boolean;
	status: number;
}

export interface GitHubOrg {
	login: string;
	avatar_url: string;
	is_personal: boolean;
}

export interface GitHubRepoSummary {
	id: number;
	name: string;
	full_name: string;
	owner: { login: string };
	private: boolean;
	default_branch: string;
	clone_url: string;
	ssh_url: string;
}

export interface CreateRepoResult {
	owner: string;
	name: string;
	full_name: string;
	private: boolean;
	default_branch: string;
}

const authHeaders = (accessToken: string) => ({
	Authorization: `Bearer ${accessToken}`,
	Accept: 'application/vnd.github+json',
	'User-Agent': 'Hezo/1.0',
});

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
	const trimmed = url.trim().replace(/\.git$/, '');

	const sshMatch = trimmed.match(/^git@github\.com:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
	if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

	const httpsMatch = trimmed.match(
		/^(?:https?:\/\/)?github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/?$/,
	);
	if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

	const shortMatch = trimmed.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
	if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };

	return null;
}

export async function validateRepoAccess(
	owner: string,
	repo: string,
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<RepoAccessResult> {
	const res = await fetchFn(`${getApiBaseUrl()}/repos/${owner}/${repo}`, {
		headers: authHeaders(accessToken),
	});
	return { accessible: res.status === 200, status: res.status };
}

export async function fetchAuthenticatedUser(
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<{ login: string; avatar_url: string } | null> {
	const res = await fetchFn(`${getApiBaseUrl()}/user`, { headers: authHeaders(accessToken) });
	if (!res.ok) return null;
	return (await res.json()) as { login: string; avatar_url: string };
}

export async function listUserOrgs(
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<GitHubOrg[]> {
	const user = await fetchAuthenticatedUser(accessToken, fetchFn);
	const personal: GitHubOrg[] = user
		? [{ login: user.login, avatar_url: user.avatar_url, is_personal: true }]
		: [];

	const res = await fetchFn(`${getApiBaseUrl()}/user/orgs?per_page=100`, {
		headers: authHeaders(accessToken),
	});
	if (!res.ok) return personal;

	const orgs = (await res.json()) as Array<{ login: string; avatar_url: string }>;
	return [
		...personal,
		...orgs.map((o) => ({ login: o.login, avatar_url: o.avatar_url, is_personal: false })),
	];
}

export async function listAccessibleRepos(
	owner: string,
	query: string | undefined,
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<GitHubRepoSummary[]> {
	const user = await fetchAuthenticatedUser(accessToken, fetchFn);
	const isPersonal = user?.login.toLowerCase() === owner.toLowerCase();

	const path = isPersonal
		? `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator`
		: `/orgs/${owner}/repos?per_page=100&sort=updated`;

	const res = await fetchFn(`${getApiBaseUrl()}${path}`, { headers: authHeaders(accessToken) });
	if (!res.ok) return [];

	const repos = (await res.json()) as GitHubRepoSummary[];
	const filtered = query
		? repos.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()))
		: repos;
	return filtered.slice(0, 50);
}

export async function createGitHubRepo(
	owner: string,
	name: string,
	isPrivate: boolean,
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<CreateRepoResult> {
	const user = await fetchAuthenticatedUser(accessToken, fetchFn);
	const isPersonal = user?.login.toLowerCase() === owner.toLowerCase();

	const path = isPersonal ? '/user/repos' : `/orgs/${owner}/repos`;
	const res = await fetchFn(`${getApiBaseUrl()}${path}`, {
		method: 'POST',
		headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to create GitHub repo (${res.status}): ${body}`);
	}

	const data = (await res.json()) as {
		name: string;
		full_name: string;
		private: boolean;
		default_branch: string;
		owner: { login: string };
	};
	return {
		owner: data.owner.login,
		name: data.name,
		full_name: data.full_name,
		private: data.private,
		default_branch: data.default_branch,
	};
}

// Mirrors the `github` capability registry entry — the union of scopes the
// REST helpers need to register SSH keys, list orgs/repos, and create repos.
const REQUIRED_REPO_SETUP_SCOPES = ['repo', 'read:org', 'write:public_key'];

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

/**
 * Fetch the authenticated user's full identity — used when establishing an
 * OAuth connection (account id keys the `oauth_connections` row; email/avatar
 * populate its metadata).
 */
export async function fetchAccount(
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<GitHubAccount> {
	const res = await fetchFn(`${getApiBaseUrl()}/user`, { headers: authHeaders(accessToken) });
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
		const parsed = JSON.parse(body) as { errors?: Array<{ message?: string }> };
		return (parsed.errors ?? []).some((e) => /key is already in use/i.test(e.message ?? ''));
	} catch {
		return /key is already in use/i.test(body);
	}
}
