export interface GoogleTokenResponse {
	access_token: string;
	token_type: string;
	scope: string;
}

export interface GoogleUserInfo {
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
): Promise<GoogleTokenResponse> {
	const res = await fetchFn('https://oauth2.googleapis.com/token', {
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

	if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
	const data = (await res.json()) as Record<string, unknown>;
	if (data.error) throw new Error(`Google OAuth error: ${data.error_description || data.error}`);
	return data as unknown as GoogleTokenResponse;
}

export async function fetchUserInfo(
	accessToken: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<GoogleUserInfo> {
	const res = await fetchFn('https://www.googleapis.com/oauth2/v1/userinfo', {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
		},
	});

	if (!res.ok) throw new Error(`Google user info fetch failed: ${res.status}`);
	return (await res.json()) as GoogleUserInfo;
}
