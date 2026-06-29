import { describe, expect, it } from 'vitest';
import { registerClient } from '../src/services/oauth/dcr';
import type { FetchFn } from '../src/services/oauth/provider-generic';

/**
 * Branch-coverage companion for `oauth/dcr.ts`. The happy path is exercised in
 * `connectors.test.ts` via a fake server; this file drives the conditional
 * arms with a stub `FetchFn` (the production code accepts an injected fetch):
 * the optional `client_name`/`scope`/`additionalParams` request-body branches,
 * the non-ok error path (with and without `error`/`error_description`),
 * unparseable response body, the missing-`client_id` rejection, and the
 * optional-field type guards on the success response. No real network.
 */

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

const ENDPOINT = 'https://as.example/register';

describe('registerClient — request body branches', () => {
	it('includes client_name, scope, and additionalParams when supplied', async () => {
		let sentBody: Record<string, unknown> = {};
		const fetchFn: FetchFn = async (_input, init) => {
			sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ client_id: 'cid-1' });
		};
		const result = await registerClient(
			{
				registrationEndpoint: ENDPOINT,
				redirectUri: 'https://hezo/callback',
				clientName: 'Hezo Test',
				scope: 'read write',
				additionalParams: { software_id: 'hezo' },
			},
			fetchFn,
		);
		expect(result.clientId).toBe('cid-1');
		expect(sentBody.client_name).toBe('Hezo Test');
		expect(sentBody.scope).toBe('read write');
		expect(sentBody.software_id).toBe('hezo');
		expect(sentBody.token_endpoint_auth_method).toBe('none');
		expect(sentBody.redirect_uris).toEqual(['https://hezo/callback']);
	});

	it('omits client_name/scope/additionalParams when not supplied', async () => {
		let sentBody: Record<string, unknown> = {};
		const fetchFn: FetchFn = async (_input, init) => {
			sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ client_id: 'cid-2' });
		};
		await registerClient(
			{ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' },
			fetchFn,
		);
		expect('client_name' in sentBody).toBe(false);
		expect('scope' in sentBody).toBe(false);
	});
});

describe('registerClient — success-response optional fields', () => {
	it('maps every optional field when present and correctly typed', async () => {
		const fetchFn: FetchFn = async () =>
			jsonResponse({
				client_id: 'cid-full',
				client_secret: 'shh',
				registration_access_token: 'rat',
				registration_client_uri: 'https://as.example/clients/cid-full',
				client_id_issued_at: 1700000000,
				client_secret_expires_at: 1800000000,
			});
		const result = await registerClient(
			{ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' },
			fetchFn,
		);
		expect(result.clientSecret).toBe('shh');
		expect(result.registrationAccessToken).toBe('rat');
		expect(result.registrationClientUri).toBe('https://as.example/clients/cid-full');
		expect(result.clientIdIssuedAt).toBe(1700000000);
		expect(result.clientSecretExpiresAt).toBe(1800000000);
		expect(result.raw.client_id).toBe('cid-full');
	});

	it('leaves optional fields undefined when absent or wrongly typed', async () => {
		const fetchFn: FetchFn = async () =>
			jsonResponse({
				client_id: 'cid-min',
				// Wrong types — guards must reject these.
				client_secret: 123,
				registration_access_token: false,
				registration_client_uri: null,
				client_id_issued_at: '1700000000',
				client_secret_expires_at: 'never',
			});
		const result = await registerClient(
			{ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' },
			fetchFn,
		);
		expect(result.clientSecret).toBeUndefined();
		expect(result.registrationAccessToken).toBeUndefined();
		expect(result.registrationClientUri).toBeUndefined();
		expect(result.clientIdIssuedAt).toBeUndefined();
		expect(result.clientSecretExpiresAt).toBeUndefined();
	});
});

describe('registerClient — error branches', () => {
	it('throws with provider error + error_description on non-ok JSON', async () => {
		const fetchFn: FetchFn = async () =>
			jsonResponse({ error: 'invalid_redirect_uri', error_description: 'bad uri' }, 400);
		await expect(
			registerClient({ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' }, fetchFn),
		).rejects.toThrow(/invalid_redirect_uri — bad uri/);
	});

	it('falls back to the HTTP status when the error body has no error code', async () => {
		const fetchFn: FetchFn = async () => jsonResponse({}, 503);
		await expect(
			registerClient({ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' }, fetchFn),
		).rejects.toThrow(/DCR registration failed at .*: 503/);
	});

	it('treats an unparseable error body as empty and uses the status', async () => {
		const fetchFn: FetchFn = async () => new Response('<<not json>>', { status: 500 });
		await expect(
			registerClient({ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' }, fetchFn),
		).rejects.toThrow(/: 500$/);
	});

	it('rejects a 2xx response that omits client_id', async () => {
		const fetchFn: FetchFn = async () => jsonResponse({ note: 'no id here' });
		await expect(
			registerClient({ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' }, fetchFn),
		).rejects.toThrow('DCR response missing client_id');
	});

	it('rejects a 2xx response whose client_id is the wrong type', async () => {
		const fetchFn: FetchFn = async () => jsonResponse({ client_id: 42 });
		await expect(
			registerClient({ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' }, fetchFn),
		).rejects.toThrow('DCR response missing client_id');
	});

	it('treats an unparseable 2xx body as empty → missing client_id', async () => {
		const fetchFn: FetchFn = async () => new Response('not json', { status: 200 });
		await expect(
			registerClient({ registrationEndpoint: ENDPOINT, redirectUri: 'https://hezo/cb' }, fetchFn),
		).rejects.toThrow('DCR response missing client_id');
	});
});
