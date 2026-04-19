export interface GitHubTokenResponse {
	access_token: string;
	token_type: string;
	scope: string;
}

export interface GitHubUserInfo {
	login: string;
	avatar_url: string;
	email: string | null;
}

export type FetchFn = typeof globalThis.fetch;

function getOAuthBase(): string {
	return process.env.GITHUB_OAUTH_BASE_URL || 'https://github.com';
}

function getApiBase(): string {
	return process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
}

export async function exchangeCode(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<GitHubTokenResponse> {
	const res = await fetchFn(`${getOAuthBase()}/login/oauth/access_token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri,
		}),
	});

	if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`);
	const data = (await res.json()) as Record<string, unknown>;
	if (data.error) throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
	return data as unknown as GitHubTokenResponse;
}

export async function fetchUserInfo(
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<GitHubUserInfo> {
	const res = await fetchFn(`${getApiBase()}/user`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/vnd.github+json',
		},
	});

	if (!res.ok) throw new Error(`GitHub user info fetch failed: ${res.status}`);
	return (await res.json()) as GitHubUserInfo;
}
