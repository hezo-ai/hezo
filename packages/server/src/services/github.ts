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
	/**
	 * Whether the token's account can push to the repo, read from the
	 * `permissions` object GitHub returns on the repo response. `null` means
	 * unknown — the field was absent or malformed — and is never treated as
	 * "yes": a missing signal must not manufacture write access the account
	 * may not have.
	 */
	canPush: boolean | null;
	/**
	 * Whether the repo is private, off the same response. `null` means unknown -
	 * the field was absent or the body unreadable - and is never read as "public",
	 * so a message that names the visibility can decline to rather than guess.
	 */
	isPrivate: boolean | null;
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

export type CreateRepoResult =
	| {
			status: 'created';
			owner: string;
			name: string;
			full_name: string;
			private: boolean;
			default_branch: string;
	  }
	| {
			status: 'already_exists';
			owner: string;
			name: string;
			/**
			 * Visibility of the repo that is already there, when it could be read.
			 *
			 * Carried because "already exists" on its own is the least useful true
			 * thing to say: the case that actually confuses people is asking for a
			 * public repo whose name is taken by a **private** one they cannot see in
			 * the picker, so the message needs to be able to name it.
			 */
			existingPrivate: boolean | null;
	  };

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

/**
 * Check that the token's account can reach the repo, and — on the same
 * response — whether it can *write* to it. A 200 only proves read: a read-only
 * collaborator, and anyone at all on a public repo, gets one. Push access lives
 * in the response's `permissions` object, so reading it here is free and is the
 * difference between catching a write gap at link time and discovering it when
 * an agent's push is silently denied mid-run.
 */
export async function validateRepoAccess(
	owner: string,
	repo: string,
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<RepoAccessResult> {
	const res = await fetchFn(`${getApiBaseUrl()}/repos/${owner}/${repo}`, {
		headers: authHeaders(accessToken),
	});
	if (res.status !== 200) {
		return { accessible: false, status: res.status, canPush: null, isPrivate: null };
	}
	// One read of the body for both facts: it is the same response, and asking
	// twice would be a second API call for something already in hand.
	const { canPush, isPrivate } = await parseRepoFacts(res);
	return { accessible: true, status: res.status, canPush, isPrivate };
}

/**
 * Read `permissions.push` and `private` off a repo response. Any shape that
 * doesn't carry a boolean where one is expected — an unexpected body, a non-JSON
 * response, an API that omits the field — is reported as unknown rather than
 * assumed either way.
 */
async function parseRepoFacts(res: Response): Promise<{
	canPush: boolean | null;
	isPrivate: boolean | null;
}> {
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { canPush: null, isPrivate: null };
	}
	if (typeof body !== 'object' || body === null) return { canPush: null, isPrivate: null };
	const permissions = (body as { permissions?: unknown }).permissions;
	const push =
		typeof permissions === 'object' && permissions !== null
			? (permissions as { push?: unknown }).push
			: undefined;
	const priv = (body as { private?: unknown }).private;
	return {
		canPush: typeof push === 'boolean' ? push : null,
		isPrivate: typeof priv === 'boolean' ? priv : null,
	};
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
	// Asked before creating, not only inferred from the failure afterwards.
	//
	// The 422 path below does catch a collision, but only if GitHub's error prose
	// still matches - and it can say nothing about the repo that is in the way.
	// The case that actually confuses people is a **private** repo holding the
	// name: it is invisible in the picker, so "create" looks like the only option
	// and the collision reads as a bug in Hezo. One GET turns that into a
	// statement of what is there.
	const existing = await validateRepoAccess(owner, name, accessToken, fetchFn);
	if (existing.accessible) {
		log.info('GitHub repo already exists, refusing to create', { owner, name });
		return { status: 'already_exists', owner, name, existingPrivate: existing.isPrivate };
	}

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
		if (res.status === 422 && isRepoNameAlreadyExists(body)) {
			// The race backstop, and the fallback for a repo the check could not see
			// (an org repo the token may create in but not read). Kept rather than
			// replaced: the pre-check narrows the window, it does not close it.
			log.info('GitHub repo name already exists, surfacing as already_exists', {
				owner,
				name,
			});
			return { status: 'already_exists', owner, name, existingPrivate: null };
		}
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
		status: 'created',
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

interface GitHubFieldError {
	resource?: string;
	code?: string;
	field?: string;
	message?: string;
}

function matchesGitHubFieldError(
	body: string,
	predicate: (e: GitHubFieldError) => boolean,
): boolean {
	try {
		const parsed = JSON.parse(body) as { errors?: GitHubFieldError[] };
		return (parsed.errors ?? []).some(predicate);
	} catch {
		return false;
	}
}

function isKeyAlreadyInUse(body: string): boolean {
	if (matchesGitHubFieldError(body, (e) => /key is already in use/i.test(e.message ?? ''))) {
		return true;
	}
	return /key is already in use/i.test(body);
}

function isRepoNameAlreadyExists(body: string): boolean {
	return matchesGitHubFieldError(
		body,
		(e) => e.field === 'name' && /already exists/i.test(e.message ?? ''),
	);
}
