import { AiAuthMethod, AiProvider, AiProviderStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { getProviderConfigCredential } from '../src/services/ai-provider-keys';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

/**
 * Covers replacing a stored credential through PATCH /ai-providers/:configId —
 * the path the settings Edit dialog saves through. The interesting half is what
 * must NOT happen: a rename must leave the credential and status alone, and a
 * rejected key must leave the stored one intact.
 *
 * SKIP_AI_KEY_VALIDATION is deliberately NOT set here: the live pre-flight is
 * part of what a rotation is being held to, and it is stubbed via globalThis.fetch
 * so each test picks whether the provider accepts the key.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let nonSuperuserToken: string;

const originalFetch = globalThis.fetch;
let prevSkip: string | undefined;

beforeAll(async () => {
	prevSkip = process.env.SKIP_AI_KEY_VALIDATION;
	process.env.SKIP_AI_KEY_VALIDATION = undefined;
	// biome-ignore lint/performance/noDelete: the code path branches on presence, not value
	delete process.env.SKIP_AI_KEY_VALIDATION;

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Plain Admin', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

beforeEach(async () => {
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await db.query('DELETE FROM ai_provider_configs');
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(async () => {
	if (prevSkip === undefined) {
		// biome-ignore lint/performance/noDelete: restore absence, not an empty string
		delete process.env.SKIP_AI_KEY_VALIDATION;
	} else {
		process.env.SKIP_AI_KEY_VALIDATION = prevSkip;
	}
	await safeClose(db);
});

/** DeepSeek has no key-prefix constraint, so a free-form key is accepted. */
async function createConfig(label: string, apiKey = 'dsk-original'): Promise<string> {
	const res = await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ provider: AiProvider.DeepSeek, api_key: apiKey, label }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { data: { id: string } }).data.id;
}

function patch(configId: string, body: Record<string, unknown>, as = token) {
	return app.request(`/api/ai-providers/${configId}`, {
		method: 'PATCH',
		headers: { ...authHeader(as), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function readRow(configId: string) {
	const res = await db.query<{
		encrypted_credential: string;
		status: string;
		auth_method: string;
		label: string;
		metadata: Record<string, unknown> | null;
	}>(
		`SELECT encrypted_credential, status, auth_method, label, metadata
		 FROM ai_provider_configs WHERE id = $1`,
		[configId],
	);
	return res.rows[0];
}

it('replaces the stored credential and reports it without echoing the value', async () => {
	const id = await createConfig('rotate-me');
	const before = await readRow(id);

	const res = await patch(id, { api_key: 'dsk-rotated' });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { data: Record<string, unknown> };
	expect(body.data.credential_updated).toBe(true);
	// Nothing derived from the credential may come back over the wire.
	expect(JSON.stringify(body.data)).not.toContain('dsk-rotated');

	const after = await readRow(id);
	expect(after.encrypted_credential).not.toBe(before.encrypted_credential);

	const cred = await getProviderConfigCredential(db, masterKeyManager, id);
	expect(cred?.value).toBe('dsk-rotated');
});

it('clears an invalid status when the replacement key verifies', async () => {
	const id = await createConfig('recover-me');
	await db.query(`UPDATE ai_provider_configs SET status = $1 WHERE id = $2`, [
		AiProviderStatus.Invalid,
		id,
	]);

	expect((await patch(id, { api_key: 'dsk-good' })).status).toBe(200);
	expect((await readRow(id)).status).toBe(AiProviderStatus.Verified);
});

it('leaves the credential, auth method and status untouched when only the label changes', async () => {
	const id = await createConfig('rename-me');
	await db.query(`UPDATE ai_provider_configs SET status = $1 WHERE id = $2`, [
		AiProviderStatus.Invalid,
		id,
	]);
	const before = await readRow(id);

	const res = await patch(id, { label: 'renamed' });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { data: Record<string, unknown> };
	expect(body.data.credential_updated).toBeUndefined();

	const after = await readRow(id);
	expect(after.label).toBe('renamed');
	expect(after.encrypted_credential).toBe(before.encrypted_credential);
	expect(after.auth_method).toBe(before.auth_method);
	// A rename must not launder an invalid credential into a verified one.
	expect(after.status).toBe(AiProviderStatus.Invalid);
});

it('treats a blank api_key as "keep the stored credential", not as an empty one', async () => {
	const id = await createConfig('blank-key');
	const before = await readRow(id);

	expect((await patch(id, { label: 'blank-key-2', api_key: '   ' })).status).toBe(200);

	const after = await readRow(id);
	expect(after.label).toBe('blank-key-2');
	expect(after.encrypted_credential).toBe(before.encrypted_credential);
});

it('saves a label, a runtime and a credential in one request', async () => {
	const res = await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: AiProvider.Kimi,
			api_key: 'sk-moonshot-one',
			label: 'kimi-combined',
		}),
	});
	expect(res.status).toBe(201);
	const id = ((await res.json()) as { data: { id: string } }).data.id;

	expect(
		(await patch(id, { label: 'kimi-renamed', runtime: 'kimi', api_key: 'sk-moonshot-two' }))
			.status,
	).toBe(200);

	const after = await readRow(id);
	expect(after.label).toBe('kimi-renamed');
	const cred = await getProviderConfigCredential(db, masterKeyManager, id);
	expect(cred?.value).toBe('sk-moonshot-two');
	const runtime = await db.query<{ runtime: string }>(
		`SELECT runtime FROM ai_provider_configs WHERE id = $1`,
		[id],
	);
	expect(runtime.rows[0].runtime).toBe('kimi');
});

it('rejects a replacement key the provider refuses, leaving the stored one intact', async () => {
	const id = await createConfig('reject-me');
	const before = await readRow(id);

	globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
	const res = await patch(id, { api_key: 'dsk-rejected' });
	expect(res.status).toBe(400);
	expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_KEY');

	expect((await readRow(id)).encrypted_credential).toBe(before.encrypted_credential);
});

it('rejects a replacement key with the wrong prefix for its provider', async () => {
	const res = await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: AiProvider.Anthropic,
			api_key: 'sk-ant-original',
			label: 'anthropic-prefix',
		}),
	});
	expect(res.status).toBe(201);
	const id = ((await res.json()) as { data: { id: string } }).data.id;
	const before = await readRow(id);

	const bad = await patch(id, { api_key: 'nope-wrong-prefix' });
	expect(bad.status).toBe(400);
	expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_KEY_FORMAT');
	expect((await readRow(id)).encrypted_credential).toBe(before.encrypted_credential);
});

it('rejects switching to subscription auth on a provider that has none', async () => {
	// DeepSeek is API-key only, so the switch is refused before the blob is read.
	const id = await createConfig('sub-unsupported');
	const res = await patch(id, {
		api_key: '{"anything": true}',
		auth_method: AiAuthMethod.Subscription,
	});
	expect(res.status).toBe(400);
	expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
		'UNSUPPORTED_AUTH_METHOD',
	);
});

it('rejects a malformed subscription blob on a provider that supports one', async () => {
	const created = await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: AiProvider.Anthropic,
			api_key: 'sk-ant-sub-seed',
			label: 'anthropic-sub',
		}),
	});
	expect(created.status).toBe(201);
	const id = ((await created.json()) as { data: { id: string } }).data.id;
	const before = await readRow(id);

	const res = await patch(id, {
		api_key: 'not-a-valid-blob',
		auth_method: AiAuthMethod.Subscription,
	});
	expect(res.status).toBe(400);
	expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
		'INVALID_SUBSCRIPTION_BLOB',
	);
	// A refused blob must not have flipped auth_method or touched the credential.
	const after = await readRow(id);
	expect(after.auth_method).toBe(before.auth_method);
	expect(after.encrypted_credential).toBe(before.encrypted_credential);
});

it('updates a local runner base URL on its own, preserving other metadata', async () => {
	const res = await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: AiProvider.Ollama,
			api_key: '',
			base_url: 'http://host.docker.internal:11434',
			label: 'ollama-local',
		}),
	});
	expect(res.status).toBe(201);
	const id = ((await res.json()) as { data: { id: string } }).data.id;

	// A key alongside the base URL is what the create route stores here, so seed an
	// unrelated metadata key to prove the merge does not clobber it.
	await db.query(
		`UPDATE ai_provider_configs SET metadata = metadata || '{"keep_me": "yes"}'::jsonb WHERE id = $1`,
		[id],
	);
	const before = await readRow(id);

	expect((await patch(id, { base_url: 'http://host.docker.internal:9999/' })).status).toBe(200);

	const after = await readRow(id);
	expect(after.metadata?.base_url).toBe('http://host.docker.internal:9999');
	expect(after.metadata?.keep_me).toBe('yes');
	// No credential was sent, so the stored one is untouched.
	expect(after.encrypted_credential).toBe(before.encrypted_credential);
});

it('rejects a malformed base URL', async () => {
	const res = await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: AiProvider.LmStudio,
			api_key: '',
			base_url: 'http://127.0.0.1:1234',
			label: 'lmstudio-local',
		}),
	});
	expect(res.status).toBe(201);
	const id = ((await res.json()) as { data: { id: string } }).data.id;

	const bad = await patch(id, { base_url: 'ftp://nope' });
	expect(bad.status).toBe(400);
	expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_BASE_URL');
});

it('404s for an unknown config and 403s for a non-superuser', async () => {
	const missing = await patch('00000000-0000-0000-0000-000000000000', { api_key: 'dsk-x' });
	expect(missing.status).toBe(404);

	const id = await createConfig('guarded');
	const forbidden = await patch(id, { api_key: 'dsk-y' }, nonSuperuserToken);
	expect(forbidden.status).toBe(403);
});

it('rejects a request that carries nothing to update', async () => {
	const id = await createConfig('nothing');
	const res = await patch(id, {});
	expect(res.status).toBe(400);
	expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
});
