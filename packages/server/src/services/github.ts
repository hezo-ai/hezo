export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RepoAccessResult {
	accessible: boolean;
	status: number;
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
	// Handle https://github.com/owner/repo or github.com/owner/repo
	const httpsMatch = url.match(
		/^(?:https?:\/\/)?github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/?$/,
	);
	if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

	// Handle owner/repo shorthand
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
	const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'Hezo/1.0',
		},
	});
	return { accessible: res.status === 200, status: res.status };
}

export async function registerSSHKeyOnGitHub(
	publicKey: string,
	title: string,
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<{ id: number }> {
	const res = await fetchFn('https://api.github.com/user/keys', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'User-Agent': 'Hezo/1.0',
		},
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
	const res = await fetchFn(`https://api.github.com/user/keys/${keyId}`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'Hezo/1.0',
		},
	});

	if (!res.ok && res.status !== 404) {
		throw new Error(`Failed to remove SSH key from GitHub (${res.status})`);
	}
}
