export interface OpenAITokenResponse {
	access_token: string;
	token_type: string;
	scope: string;
}

export interface OpenAIUserInfo {
	email: string;
	name: string;
}

export type FetchFn = typeof globalThis.fetch;

export async function exchangeCode(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<OpenAITokenResponse> {
	const res = await fetchFn('https://auth.openai.com/oauth/token', {
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
			grant_type: 'authorization_code',
		}),
	});

	if (!res.ok) throw new Error(`OpenAI token exchange failed: ${res.status}`);
	const data = (await res.json()) as Record<string, unknown>;
	if (data.error) throw new Error(`OpenAI OAuth error: ${data.error_description || data.error}`);
	return data as unknown as OpenAITokenResponse;
}

export async function fetchUserInfo(
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<OpenAIUserInfo> {
	const res = await fetchFn('https://api.openai.com/v1/me', {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
		},
	});

	if (!res.ok) throw new Error(`OpenAI user info fetch failed: ${res.status}`);
	return (await res.json()) as OpenAIUserInfo;
}
