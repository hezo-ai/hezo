import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signAdminJwt } from '../src/middleware/auth';
import { authHeader } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

let ctx: ServerTestContext;
let boardUserToken: string;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function post(path: string, body: unknown, token = ctx.token) {
	return ctx.app.request(path, {
		method: 'POST',
		headers: { ...authHeader(token), ...JSON_HEADERS },
		body: JSON.stringify(body),
	});
}

function patch(path: string, body: unknown) {
	return ctx.app.request(path, {
		method: 'PATCH',
		headers: { ...authHeader(ctx.token), ...JSON_HEADERS },
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	ctx = await createTestContext();
	// A non-superuser board user: authenticated, but not admin-equivalent.
	const user = await ctx.db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Board User', false) RETURNING id",
	);
	boardUserToken = await signAdminJwt(ctx.masterKeyManager, user.rows[0].id);
});

afterAll(() => destroyTestContext(ctx));

describe('authorization', () => {
	it('rejects a non-admin on every secrets route with 403', async () => {
		const denied = [
			await ctx.app.request('/api/credentials', { headers: authHeader(boardUserToken) }),
			await post('/api/secrets', { name: 'X', value: 'v' }, boardUserToken),
			await ctx.app.request('/api/secrets/00000000-0000-0000-0000-000000000000', {
				method: 'PATCH',
				headers: { ...authHeader(boardUserToken), ...JSON_HEADERS },
				body: '{}',
			}),
			await ctx.app.request('/api/secrets/00000000-0000-0000-0000-000000000000', {
				method: 'DELETE',
				headers: authHeader(boardUserToken),
			}),
		];
		for (const res of denied) {
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
		}
	});
});

describe('POST /api/secrets', () => {
	it('rejects a missing name or value with 400', async () => {
		for (const body of [{}, { name: '  ', value: 'v' }, { name: 'GOOD_NAME' }]) {
			const res = await post('/api/secrets', body);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'INVALID_REQUEST',
			);
		}
	});

	it('rejects a name outside the placeholder grammar with 400', async () => {
		for (const name of ['lowercase', 'HAS-HYPHEN', '1STARTS_WITH_DIGIT', `X${'Y'.repeat(70)}`]) {
			const res = await post('/api/secrets', { name, value: 'v' });
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.code).toBe('INVALID_REQUEST');
			expect(body.error.message).toMatch(/name must match/);
		}
	});

	it('returns 401 LOCKED when the key is unavailable', async () => {
		const spy = vi.spyOn(ctx.masterKeyManager, 'getKey').mockReturnValue(null);
		try {
			const res = await post('/api/secrets', { name: 'LOCKED_SECRET', value: 'v' });
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe('LOCKED');
		} finally {
			spy.mockRestore();
		}
		const row = await ctx.db.query("SELECT id FROM secrets WHERE name = 'LOCKED_SECRET'");
		expect(row.rows).toHaveLength(0);
	});

	it('creates a secret encrypted at rest with normalized allowed hosts', async () => {
		const res = await post('/api/secrets', {
			name: 'COVFILL_API_KEY',
			value: 'covfill-secret-value',
			category: 'api_token',
			allowed_hosts: ['  API.Example.COM ', '', 'api.other.io'],
			allow_all_hosts: false,
			allow_body_substitution: true,
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data as {
			id: string;
			name: string;
			category: string;
			allowed_hosts: string[];
			allow_all_hosts: boolean;
			allow_body_substitution: boolean;
		};
		expect(data.name).toBe('COVFILL_API_KEY');
		expect(data.category).toBe('api_token');
		expect(data.allowed_hosts).toEqual(['api.example.com', 'api.other.io']);
		expect(data.allow_all_hosts).toBe(false);
		expect(data.allow_body_substitution).toBe(true);
		// The response never carries the value, and the row is encrypted at rest.
		expect(JSON.stringify(data)).not.toContain('covfill-secret-value');
		const row = await ctx.db.query<{ encrypted_value: string }>(
			'SELECT encrypted_value FROM secrets WHERE id = $1',
			[data.id],
		);
		expect(row.rows[0].encrypted_value).not.toContain('covfill-secret-value');
	});

	it('upserts on a duplicate name, replacing config wholesale', async () => {
		const res = await post('/api/secrets', {
			name: 'COVFILL_API_KEY',
			value: 'rotated-value',
			allowed_hosts: ['only.example.com'],
			allow_all_hosts: true,
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data as {
			allowed_hosts: string[];
			allow_all_hosts: boolean;
			category: string;
		};
		expect(data.allowed_hosts).toEqual(['only.example.com']);
		expect(data.allow_all_hosts).toBe(true);
		// Only one row for the name.
		const rows = await ctx.db.query("SELECT id FROM secrets WHERE name = 'COVFILL_API_KEY'");
		expect(rows.rows).toHaveLength(1);
	});
});

describe('GET /api/credentials', () => {
	it('lists secrets with constant (untracked) usage stats', async () => {
		const res = await ctx.app.request('/api/credentials', { headers: authHeader(ctx.token) });
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{
			name: string;
			use_count: number | null;
			last_host: string | null;
			last_used_at: string | null;
		}>;
		const secret = rows.find((r) => r.name === 'COVFILL_API_KEY');
		expect(secret).toBeTruthy();
		// Egress requests are no longer audited, so per-secret usage is untracked.
		expect(secret?.use_count).toBe(0);
		expect(secret?.last_host).toBeNull();
		expect(secret?.last_used_at).toBeNull();
		// No encrypted material leaks into the listing.
		expect(JSON.stringify(rows)).not.toContain('rotated-value');
	});
});

describe('PATCH /api/secrets/:secretId', () => {
	let secretId: string;

	beforeAll(async () => {
		const res = await post('/api/secrets', {
			name: 'COVFILL_PATCH_TARGET',
			value: 'initial-value',
			allowed_hosts: ['a.example.com'],
		});
		secretId = ((await res.json()).data as { id: string }).id;
	});

	it('404s on an unknown secret', async () => {
		const res = await patch('/api/secrets/00000000-0000-0000-0000-000000000000', {
			category: 'api_token',
		});
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
	});

	it('returns 401 LOCKED when patching the value with the key unavailable', async () => {
		const before = await ctx.db.query<{ encrypted_value: string }>(
			'SELECT encrypted_value FROM secrets WHERE id = $1',
			[secretId],
		);
		const spy = vi.spyOn(ctx.masterKeyManager, 'getKey').mockReturnValue(null);
		try {
			const res = await patch(`/api/secrets/${secretId}`, { value: 'new-value' });
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe('LOCKED');
		} finally {
			spy.mockRestore();
		}
		const after = await ctx.db.query<{ encrypted_value: string }>(
			'SELECT encrypted_value FROM secrets WHERE id = $1',
			[secretId],
		);
		expect(after.rows[0].encrypted_value).toBe(before.rows[0].encrypted_value);
	});

	it('rejects a non-array allowed_hosts with 400', async () => {
		const res = await patch(`/api/secrets/${secretId}`, { allowed_hosts: 'not-an-array' });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
	});

	it('an empty patch is a no-op returning the existing row', async () => {
		const res = await patch(`/api/secrets/${secretId}`, {});
		expect(res.status).toBe(200);
		expect(((await res.json()).data as { id: string }).id).toBe(secretId);
	});

	it('updates value, category, hosts, and flags together', async () => {
		const before = await ctx.db.query<{ encrypted_value: string }>(
			'SELECT encrypted_value FROM secrets WHERE id = $1',
			[secretId],
		);
		const res = await patch(`/api/secrets/${secretId}`, {
			value: 'patched-value',
			category: 'api_token',
			allowed_hosts: [' B.Example.COM '],
			allow_all_hosts: true,
			allow_body_substitution: true,
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data as {
			category: string;
			allowed_hosts: string[];
			allow_all_hosts: boolean;
			allow_body_substitution: boolean;
		};
		expect(data.category).toBe('api_token');
		expect(data.allowed_hosts).toEqual(['b.example.com']);
		expect(data.allow_all_hosts).toBe(true);
		expect(data.allow_body_substitution).toBe(true);
		const after = await ctx.db.query<{ encrypted_value: string }>(
			'SELECT encrypted_value FROM secrets WHERE id = $1',
			[secretId],
		);
		// The value was re-encrypted (ciphertext changed, plaintext never stored).
		expect(after.rows[0].encrypted_value).not.toBe(before.rows[0].encrypted_value);
		expect(after.rows[0].encrypted_value).not.toContain('patched-value');
	});
});

describe('DELETE /api/secrets/:secretId', () => {
	it('404s on an unknown secret', async () => {
		const res = await ctx.app.request('/api/secrets/00000000-0000-0000-0000-000000000000', {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
	});

	it('deletes an existing secret', async () => {
		const created = await post('/api/secrets', { name: 'COVFILL_DELETE_ME', value: 'v' });
		const id = ((await created.json()).data as { id: string }).id;

		const res = await ctx.app.request(`/api/secrets/${id}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { data: null }).data).toBeNull();

		const row = await ctx.db.query('SELECT id FROM secrets WHERE id = $1', [id]);
		expect(row.rows).toHaveLength(0);
	});
});
