import { DateFormat, DEFAULT_LOCALE_SETTINGS, Language, NumberFormat } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { getSystemMeta, LOCALE_KEYS } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let nonSuperuserToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Admin', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

afterAll(async () => {
	await safeClose(db);
});

function patchLocale(body: unknown, authToken?: string) {
	return app.request('/api/instance-settings/locale', {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			...(authToken ? authHeader(authToken) : {}),
		},
		body: JSON.stringify(body),
	});
}

/**
 * Simulate a fresh, un-set-up instance. `adminPasswordIsSet` is the gate the
 * route reads, so clearing the verifier is exactly the pre-onboarding state.
 */
async function withUninitializedInstance<T>(fn: () => Promise<T>): Promise<T> {
	const saved = await db.query<{ id: string; password_public_key: string | null }>(
		'SELECT id, password_public_key FROM users WHERE is_superuser = true',
	);
	await db.query('UPDATE users SET password_public_key = NULL WHERE is_superuser = true');
	try {
		return await fn();
	} finally {
		for (const row of saved.rows) {
			await db.query('UPDATE users SET password_public_key = $1 WHERE id = $2', [
				row.password_public_key,
				row.id,
			]);
		}
	}
}

describe('GET /api/instance-settings', () => {
	it('reports the default locale before anything is chosen', async () => {
		const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.locale).toEqual(DEFAULT_LOCALE_SETTINGS);
	});
});

describe('GET /api/status', () => {
	it('carries the locale publicly, so pre-auth screens can render in it', async () => {
		// No Authorization header: the language step, master-key gate, and login
		// form all need this before any credential exists.
		const res = await app.request('/api/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.locale).toEqual(DEFAULT_LOCALE_SETTINGS);
		expect(body.localeConfigured).toBe(false);
	});
});

describe('PATCH /api/instance-settings/locale', () => {
	it('persists a full three-axis update and reports it as configured', async () => {
		const res = await patchLocale(
			{ language: 'de', date_format: 'dmy', number_format: 'comma-dot' },
			token,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.locale).toEqual({
			language: Language.De,
			date_format: DateFormat.Dmy,
			number_format: NumberFormat.CommaDot,
		});
		expect(body.data.configured).toBe(true);

		// One system_meta row per axis, so a partial update touches only its own.
		expect(await getSystemMeta(db, LOCALE_KEYS.language)).toBe('de');
		expect(await getSystemMeta(db, LOCALE_KEYS.date_format)).toBe('dmy');
		expect(await getSystemMeta(db, LOCALE_KEYS.number_format)).toBe('comma-dot');
	});

	it('applies a partial update without disturbing the other axes', async () => {
		const res = await patchLocale({ language: 'ja' }, token);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.locale).toEqual({
			language: Language.Ja,
			date_format: DateFormat.Dmy,
			number_format: NumberFormat.CommaDot,
		});
	});

	it('surfaces the stored locale on the public status payload', async () => {
		const res = await app.request('/api/status');
		const body = await res.json();
		expect(body.locale.language).toBe(Language.Ja);
		expect(body.localeConfigured).toBe(true);
	});

	it('surfaces the stored locale on the authenticated settings payload', async () => {
		const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
		const body = await res.json();
		expect(body.data.locale.language).toBe(Language.Ja);
	});

	it('rejects an unsupported value with the shared validator message', async () => {
		const res = await patchLocale({ language: 'kl' }, token);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
		expect(body.error.message).toContain('language');
	});

	it('rejects a body naming no known field', async () => {
		const res = await patchLocale({ unrelated: true }, token);
		expect(res.status).toBe(400);
	});

	it('rejects a malformed body rather than 500ing', async () => {
		const res = await app.request('/api/instance-settings/locale', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...authHeader(token) },
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});
});

describe('PATCH /api/instance-settings/locale authorization', () => {
	it('is closed to anonymous callers once the instance is initialized', async () => {
		const res = await patchLocale({ language: 'fr' });
		expect(res.status).toBe(401);
	});

	it('is closed to a non-superuser once the instance is initialized', async () => {
		const res = await patchLocale({ language: 'fr' }, nonSuperuserToken);
		expect(res.status).toBe(403);
	});

	it('leaves the stored locale untouched after a rejected write', async () => {
		const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
		const body = await res.json();
		expect(body.data.locale.language).toBe(Language.Ja);
	});

	it('is public while the instance is uninitialized, so onboarding can write it', async () => {
		// The same window in which /api/auth/setup already lets anyone claim the
		// instance, so this grants nothing new - and it is what lets the language
		// step persist a choice that survives a mid-onboarding refresh.
		await withUninitializedInstance(async () => {
			const res = await patchLocale({ language: 'ko', date_format: 'ymd' });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data.locale.language).toBe(Language.Ko);
			expect(body.data.locale.date_format).toBe(DateFormat.Ymd);
		});
	});

	it('still validates while public', async () => {
		await withUninitializedInstance(async () => {
			const res = await patchLocale({ language: 'not-a-language' });
			expect(res.status).toBe(400);
		});
	});

	it('closes again as soon as the instance is initialized', async () => {
		const res = await patchLocale({ language: 'fr' });
		expect(res.status).toBe(401);
	});
});

describe('locale storage resilience', () => {
	it('degrades a corrupt stored value to the default instead of breaking the payload', async () => {
		await db.query('UPDATE system_meta SET value = $1 WHERE key = $2', [
			'gibberish',
			LOCALE_KEYS.language,
		]);
		const res = await app.request('/api/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.locale).toEqual(DEFAULT_LOCALE_SETTINGS);
	});
});
