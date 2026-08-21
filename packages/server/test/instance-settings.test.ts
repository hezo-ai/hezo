import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { setHostMemoryForTest } from '../src/lib/host-memory';
import { getSystemMeta, INSTANCE_BASE_URL_KEY } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, loginViaAuthApi } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let nonSuperuserToken: string;
let mnemonic: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	mnemonic = ctx.mnemonic;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Admin', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

afterAll(async () => {
	await safeClose(db);
});

function unlock(headers: Record<string, string> = {}) {
	// Base-URL capture fires from the /api/auth/verify request that completes
	// the challenge dance, so the headers land there.
	return loginViaAuthApi(app, mnemonic, { headers });
}

function patchBaseUrl(value: unknown, authToken = token) {
	return app.request('/api/instance-settings', {
		method: 'PATCH',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ base_url: value }),
	});
}

async function getBaseUrl(): Promise<string | null> {
	const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
	expect(res.status).toBe(200);
	return (await res.json()).data.base_url;
}

describe('GET /api/instance-settings', () => {
	it('returns null base_url on a fresh instance', async () => {
		expect(await getBaseUrl()).toBeNull();
	});
});

describe('base URL capture on unlock', () => {
	it('captures the forwarded origin on first unlock', async () => {
		const res = await unlock({ host: 'hezo.example.com', 'x-forwarded-proto': 'https' });
		expect(res.status).toBe(200);
		expect(await getSystemMeta(db, INSTANCE_BASE_URL_KEY)).toBe('https://hezo.example.com');
	});

	it('does not overwrite an already-captured value on later unlocks', async () => {
		const res = await unlock({ host: 'other.example.com', 'x-forwarded-proto': 'https' });
		expect(res.status).toBe(200);
		expect(await getSystemMeta(db, INSTANCE_BASE_URL_KEY)).toBe('https://hezo.example.com');
	});

	it('takes the first entry of a comma-separated x-forwarded-proto chain', async () => {
		await db.query('DELETE FROM system_meta WHERE key = $1', [INSTANCE_BASE_URL_KEY]);
		const res = await unlock({ host: 'chain.example.com', 'x-forwarded-proto': 'https, http' });
		expect(res.status).toBe(200);
		expect(await getSystemMeta(db, INSTANCE_BASE_URL_KEY)).toBe('https://chain.example.com');
	});

	it('defaults to http and the host header port when no proxy headers are set', async () => {
		await db.query('DELETE FROM system_meta WHERE key = $1', [INSTANCE_BASE_URL_KEY]);
		const res = await unlock({ host: 'localhost:3100' });
		expect(res.status).toBe(200);
		expect(await getSystemMeta(db, INSTANCE_BASE_URL_KEY)).toBe('http://localhost:3100');
	});
});

describe('PATCH /api/instance-settings', () => {
	it('rejects non-superusers', async () => {
		const res = await patchBaseUrl('https://x.example.com', nonSuperuserToken);
		expect(res.status).toBe(403);
	});

	it.each([
		['non-URL text', 'not a url'],
		['non-http scheme', 'ftp://x.example.com'],
		['URL with a path', 'https://x.example.com/app'],
		['URL with a query', 'https://x.example.com?q=1'],
		['URL with a fragment', 'https://x.example.com#frag'],
		['URL with credentials', 'https://user:pw@x.example.com'],
	])('rejects %s', async (_name, value) => {
		const res = await patchBaseUrl(value);
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects a non-string, non-null base_url', async () => {
		const res = await patchBaseUrl(123);
		expect(res.status).toBe(400);
	});

	it('rejects a body without base_url', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it('normalizes to a bare origin and echoes it', async () => {
		const res = await patchBaseUrl('https://Hezo.Example.com:8443/');
		expect(res.status).toBe(200);
		expect((await res.json()).data.base_url).toBe('https://hezo.example.com:8443');
		expect(await getBaseUrl()).toBe('https://hezo.example.com:8443');
	});

	it('a manually-set value survives later unlocks', async () => {
		const res = await unlock({ host: 'fresh.example.com', 'x-forwarded-proto': 'https' });
		expect(res.status).toBe(200);
		expect(await getBaseUrl()).toBe('https://hezo.example.com:8443');
	});

	it('clears the value with null', async () => {
		const res = await patchBaseUrl(null);
		expect(res.status).toBe(200);
		expect((await res.json()).data.base_url).toBeNull();
		expect(await getBaseUrl()).toBeNull();
	});
});

describe('concurrency settings', () => {
	const GIB = 1024 ** 3;

	beforeAll(() => {
		// Pin the host-memory probe to the incident's reference host: a "2GB"
		// droplet (1.92GiB MemTotal) with 6GiB swap → round to 8GiB, less the 1GiB
		// system reserve = 7 usable, so the auto default is floor(7 / 2) = 3.
		setHostMemoryForTest({ totalRamBytes: 1.92 * GIB, totalSwapBytes: 6 * GIB });
	});
	afterAll(() => setHostMemoryForTest(null));

	function patchSettings(body: Record<string, unknown>, authToken = token) {
		return app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async function getSettings(): Promise<{
		max_container_memory_gb: number;
		max_container_memory_gb_is_set: boolean;
		max_container_memory_gb_computed_default: number;
		task_container_memory_gb: number;
		default_ram_cap_per_container_gb: number;
		host_total_ram_bytes: number;
		host_total_swap_bytes: number;
	}> {
		const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		return (await res.json()).data;
	}

	it('computes the default memory budget from host memory when unset', async () => {
		const data = await getSettings();
		// round(1.92 + 6) = 8 GiB, less 1 GB for the host = 7 GB for ALL containers.
		expect(data.max_container_memory_gb).toBe(7);
		expect(data.max_container_memory_gb_is_set).toBe(false);
		expect(data.max_container_memory_gb_computed_default).toBe(7);
		// Task runs get the total less one 2 GB cap, held back so the assistant chat
		// always has somewhere to go. **5 is what this instance could already run**:
		// the reservation moved from the default into this figure, so an
		// auto-computed instance has exactly the task capacity it had before.
		expect(data.task_container_memory_gb).toBe(5);
		expect(data.default_ram_cap_per_container_gb).toBe(2);
		expect(data.host_total_swap_bytes).toBe(6 * GIB);
	});

	it('changing the ram cap moves the task share, because the chat reserve moves', async () => {
		// The cap does not divide the budget - it is the chat container's share, held
		// back off the top. So the TOTAL is fixed by host memory while the TASK share
		// moves with the cap. Asserted in both directions so a change that stopped
		// reserving would not slip through.
		expect((await patchSettings({ default_ram_cap_per_container_gb: 3 })).status).toBe(200);
		let data = await getSettings();
		expect(data.default_ram_cap_per_container_gb).toBe(3);
		expect(data.max_container_memory_gb).toBe(7); // 8 - 1, unchanged by the cap
		expect(data.task_container_memory_gb).toBe(4); // 7 - 3

		expect((await patchSettings({ default_ram_cap_per_container_gb: 1 })).status).toBe(200);
		data = await getSettings();
		expect(data.max_container_memory_gb).toBe(7);
		expect(data.task_container_memory_gb).toBe(6); // 7 - 1
		expect(data.max_container_memory_gb_is_set).toBe(false);
		await patchSettings({ default_ram_cap_per_container_gb: 2 });
	});

	it('an explicitly set budget wins over the computed default', async () => {
		const res = await patchSettings({ max_container_memory_gb: 14 });
		expect(res.status).toBe(200);
		const data = await getSettings();
		expect(data.max_container_memory_gb).toBe(14);
		expect(data.max_container_memory_gb_is_set).toBe(true);
		expect(data.max_container_memory_gb_computed_default).toBe(7);
		// The reservation applies to an explicitly-set budget too. It used not to,
		// which is how a hand-set 14 admitted 7 task containers *and* a chat one.
		expect(data.task_container_memory_gb).toBe(12);
	});

	it('null resets the budget back to the computed default', async () => {
		const res = await patchSettings({ max_container_memory_gb: null });
		expect(res.status).toBe(200);
		const data = await getSettings();
		expect(data.max_container_memory_gb).toBe(7);
		expect(data.task_container_memory_gb).toBe(5);
		expect(data.max_container_memory_gb_is_set).toBe(false);
	});

	it('refuses a budget below the per-container cap, which nothing could ever fit', async () => {
		// The admission check. Accepting it would leave every project queueing
		// forever with nothing naming the cause, so it is refused where it is set.
		const res = await patchSettings({ max_container_memory_gb: 1 });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('no container could ever start');
	});

	it('refuses a per-container cap above the budget, from the other direction', async () => {
		expect((await patchSettings({ max_container_memory_gb: 8 })).status).toBe(200);
		const res = await patchSettings({ default_ram_cap_per_container_gb: 16 });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('could never start');
		await patchSettings({ max_container_memory_gb: null });
	});

	it('rejects the retired idle-timeout setting rather than silently ignoring it', async () => {
		// The window is a constant now (CONTAINER_IDLE_TIMEOUT_MIN). A PATCH naming
		// only the retired field must 400 rather than 200-with-no-effect, so an
		// operator or script still setting it finds out.
		const res = await patchSettings({ container_idle_timeout_min: 45 });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('is required');
	});

	it.each([
		['a zero memory budget', { max_container_memory_gb: 0 }],
		['a negative memory budget', { max_container_memory_gb: -1 }],
		['an over-max memory budget', { max_container_memory_gb: 4097 }],
		['a non-integer memory budget', { max_container_memory_gb: 2.5 }],
		['a string memory budget', { max_container_memory_gb: '3' }],
		['a zero ram cap', { default_ram_cap_per_container_gb: 0 }],
		['an over-max ram cap', { default_ram_cap_per_container_gb: 513 }],
		['a non-integer ram cap', { default_ram_cap_per_container_gb: 1.5 }],
	])('rejects %s', async (_name, body) => {
		const res = await patchSettings(body);
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects non-superusers', async () => {
		const res = await patchSettings({ max_container_memory_gb: 10 }, nonSuperuserToken);
		expect(res.status).toBe(403);
	});
});
