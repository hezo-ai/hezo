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

export function getGitHubApiBase(): string {
	return process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
}

const authHeaders = (accessToken: string) => ({
	Authorization: `Bearer ${accessToken}`,
	Accept: 'application/vnd.github+json',
	'User-Agent': 'Hezo/1.0',
});

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
	const httpsMatch = url.match(
		/^(?:https?:\/\/)?github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/?$/,
	);
	if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

	const shortMatch = url.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
	if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };

	return null;
}

export async function validateRepoAccess(
	owner: string,
	repo: string,
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<RepoAccessResult> {
	const res = await fetchFn(`${getGitHubApiBase()}/repos/${owner}/${repo}`, {
		headers: authHeaders(accessToken),
	});
	return { accessible: res.status === 200, status: res.status };
}

export async function registerSSHKeyOnGitHub(
	publicKey: string,
	title: string,
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<{ id: number }> {
	const res = await fetchFn(`${getGitHubApiBase()}/user/keys`, {
		method: 'POST',
		headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, key: publicKey }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to register SSH key on GitHub (${res.status}): ${body}`);
	}

	const data = (await res.json()) as { id: number };
	return { id: data.id };
}

export async function removeSSHKeyFromGitHub(
	keyId: number,
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<void> {
	const res = await fetchFn(`${getGitHubApiBase()}/user/keys/${keyId}`, {
		method: 'DELETE',
		headers: authHeaders(accessToken),
	});

	if (!res.ok && res.status !== 404) {
		throw new Error(`Failed to remove SSH key from GitHub (${res.status})`);
	}
}

export async function fetchAuthenticatedUser(
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<{ login: string; avatar_url: string } | null> {
	const res = await fetchFn(`${getGitHubApiBase()}/user`, { headers: authHeaders(accessToken) });
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

	const res = await fetchFn(`${getGitHubApiBase()}/user/orgs?per_page=100`, {
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

	const res = await fetchFn(`${getGitHubApiBase()}${path}`, { headers: authHeaders(accessToken) });
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
	const res = await fetchFn(`${getGitHubApiBase()}${path}`, {
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
