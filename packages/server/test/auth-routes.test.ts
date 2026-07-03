import type { PGlite } from '@electric-sql/pglite';
import {
	buildLoginMessage,
	buildSetupMessage,
	buildUnlockMessage,
	deriveAuthKeyPair,
	deriveUnlockKey,
	generateMnemonic,
	signAuthMessage,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { verifyToken } from '../src/middleware/auth';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createUnsetTestApp,
	loginViaAuthApi,
	restartTestApp,
} from './helpers/app';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function postJson(app: Hono<Env>, path: string, body: unknown) {
	return app.request(path, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
}

async function getChallenge(app: Hono<Env>): Promise<{ challenge_id: string; nonce: string }> {
	const res = await app.request('/api/auth/challenge', { method: 'POST' });
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

async function errorCode(res: Response): Promise<string> {
	return (await res.json()).error.code;
}

describe('setup, unlock, and restart flows', () => {
	let app: Hono<Env>;
	let db: PGlite;
	let masterKeyManager: MasterKeyManager;
	let dataDir: string;
	const mnemonic = generateMnemonic();
	const keys = deriveAuthKeyPair(mnemonic);
	const unlockKey = deriveUnlockKey(mnemonic);

	beforeAll(async () => {
		({ app, db, masterKeyManager, dataDir } = await createUnsetTestApp());
	});

	afterAll(async () => {
		await safeClose(db);
	});

	function setupBody(overrides: Record<string, string> = {}) {
		return {
			public_key: keys.publicKeyHex,
			unlock_key: unlockKey,
			signature: signAuthMessage(keys.privateKey, buildSetupMessage(keys.publicKeyHex, unlockKey)),
			...overrides,
		};
	}

	it('rejects malformed setup payloads with 400', async () => {
		for (const body of [
			{},
			setupBody({ public_key: 'short' }),
			setupBody({ unlock_key: 'Z'.repeat(64) }),
			setupBody({ signature: 'ab' }),
		]) {
			const res = await postJson(app, '/api/auth/setup', body);
			expect(res.status).toBe(400);
			expect(await errorCode(res)).toBe('INVALID_REQUEST');
		}
	});

	it('refuses challenges before setup', async () => {
		const res = await app.request('/api/auth/challenge', { method: 'POST' });
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('SETUP_REQUIRED');
	});

	it('refuses verify before setup', async () => {
		const res = await postJson(app, '/api/auth/verify', {
			challenge_id: '00000000-0000-4000-8000-000000000000',
			signature: 'ab'.repeat(64),
		});
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('SETUP_REQUIRED');
	});

	it('rejects a bad setup signature and persists nothing', async () => {
		// Signed over a different unlock key than the one submitted.
		const res = await postJson(
			app,
			'/api/auth/setup',
			setupBody({
				signature: signAuthMessage(
					keys.privateKey,
					buildSetupMessage(keys.publicKeyHex, 'ff'.repeat(32)),
				),
			}),
		);
		expect(res.status).toBe(401);
		expect(await errorCode(res)).toBe('INVALID_SIGNATURE');
		expect(masterKeyManager.getState()).toBe('unset');
		const rows = await db.query(
			"SELECT key FROM system_meta WHERE key IN ('auth_public_key', 'master_key_canary')",
		);
		expect(rows.rows).toHaveLength(0);
	});

	it('enrolls, unlocks, and returns a password-setup token (not a session)', async () => {
		const res = await postJson(app, '/api/auth/setup', setupBody());
		expect(res.status).toBe(200);
		const { token } = (await res.json()).data;

		// The mnemonic only unlocks — setup mints a password-setup-scoped token, not
		// a session, so verifyToken rejects it as a general credential.
		expect(await verifyToken(token, db, masterKeyManager)).toBeNull();

		const status = await app.request('/api/status');
		expect((await status.json()).masterKeyState).toBe('unlocked');

		const superuser = await db.query('SELECT id FROM users WHERE is_superuser = true');
		expect(superuser.rows).toHaveLength(1);

		const meta = await db.query<{ key: string; value: string }>(
			"SELECT key, value FROM system_meta WHERE key IN ('auth_public_key', 'master_key_canary') ORDER BY key",
		);
		expect(meta.rows.map((r) => r.key)).toEqual(['auth_public_key', 'master_key_canary']);
		expect(meta.rows[0].value).toBe(keys.publicKeyHex);
	});

	it('rejects a second setup with 409', async () => {
		const res = await postJson(app, '/api/auth/setup', setupBody());
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('ALREADY_SET');
	});

	it('requires the unlock key after a restart, then unlocks with it', async () => {
		const restarted = await restartTestApp(db, dataDir);
		expect(restarted.masterKeyManager.getState()).toBe('locked');

		// Valid login signature, but no unlock key while locked.
		const withoutKey = await loginViaAuthApi(restarted.app, mnemonic);
		expect(withoutKey.status).toBe(401);
		expect(await errorCode(withoutKey)).toBe('UNLOCK_KEY_REQUIRED');
		expect(restarted.masterKeyManager.getState()).toBe('locked');

		const withKey = await loginViaAuthApi(restarted.app, mnemonic, { includeUnlockKey: true });
		expect(withKey.status).toBe(200);
		expect((await withKey.json()).data.token).toBeTypeOf('string');
		expect(restarted.masterKeyManager.getState()).toBe('unlocked');
	});

	it('rejects a wrong unlock key even with a valid signature', async () => {
		const restarted = await restartTestApp(db, dataDir);
		expect(restarted.masterKeyManager.getState()).toBe('locked');

		const wrongKey = 'ff'.repeat(32);
		const { challenge_id, nonce } = await getChallenge(restarted.app);
		const res = await postJson(restarted.app, '/api/auth/verify', {
			challenge_id,
			unlock_key: wrongKey,
			signature: signAuthMessage(keys.privateKey, buildUnlockMessage(nonce, wrongKey)),
		});
		expect(res.status).toBe(401);
		expect(await errorCode(res)).toBe('INVALID_UNLOCK_KEY');
		expect(restarted.masterKeyManager.getState()).toBe('locked');
	});
});

describe('login flow on an enrolled, unlocked server', () => {
	let app: Hono<Env>;
	let db: PGlite;
	let mnemonic: string;
	let masterKeyManager: MasterKeyManager;

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		mnemonic = ctx.mnemonic;
		masterKeyManager = ctx.masterKeyManager;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('rejects malformed verify payloads with 400', async () => {
		for (const body of [
			{},
			{ challenge_id: '', signature: 'ab'.repeat(64) },
			{ challenge_id: 'x', signature: 'not-hex' },
			{ challenge_id: 'x', signature: 'ab'.repeat(64), unlock_key: 'bad' },
		]) {
			const res = await postJson(app, '/api/auth/verify', body);
			expect(res.status).toBe(400);
			expect(await errorCode(res)).toBe('INVALID_REQUEST');
		}
	});

	it('rejects non-JSON bodies with 400', async () => {
		const res = await app.request('/api/auth/verify', {
			method: 'POST',
			headers: JSON_HEADERS,
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});

	it('rejects setup once enrolled', async () => {
		const keys = deriveAuthKeyPair(mnemonic);
		const unlockKey = deriveUnlockKey(mnemonic);
		const res = await postJson(app, '/api/auth/setup', {
			public_key: keys.publicKeyHex,
			unlock_key: unlockKey,
			signature: signAuthMessage(keys.privateKey, buildSetupMessage(keys.publicKeyHex, unlockKey)),
		});
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('ALREADY_SET');
	});

	it('mnemonic verify returns a password-setup token (not a session), repeatably', async () => {
		const res1 = await loginViaAuthApi(app, mnemonic);
		expect(res1.status).toBe(200);
		const token1 = (await res1.json()).data.token;

		const res2 = await loginViaAuthApi(app, mnemonic);
		expect(res2.status).toBe(200);

		// The mnemonic only unlocks: its token is password-setup-scoped, not a
		// session, so verifyToken rejects it on general routes.
		expect(await verifyToken(token1, db, masterKeyManager)).toBeNull();
	});

	it('the mnemonic token cannot access protected endpoints (only password setup)', async () => {
		const res = await loginViaAuthApi(app, mnemonic);
		const { token } = (await res.json()).data;
		const projectsRes = await app.request('/api/projects', { headers: authHeader(token) });
		expect(projectsRes.status).toBe(401);
	});

	it('rejects a replayed challenge', async () => {
		const keys = deriveAuthKeyPair(mnemonic);
		const { challenge_id, nonce } = await getChallenge(app);
		const body = {
			challenge_id,
			signature: signAuthMessage(keys.privateKey, buildLoginMessage(nonce)),
		};
		expect((await postJson(app, '/api/auth/verify', body)).status).toBe(200);

		const replay = await postJson(app, '/api/auth/verify', body);
		expect(replay.status).toBe(401);
		expect(await errorCode(replay)).toBe('INVALID_CHALLENGE');
	});

	it('rejects an unknown challenge id', async () => {
		const res = await postJson(app, '/api/auth/verify', {
			challenge_id: '00000000-0000-4000-8000-000000000000',
			signature: 'ab'.repeat(64),
		});
		expect(res.status).toBe(401);
		expect(await errorCode(res)).toBe('INVALID_CHALLENGE');
	});

	it("rejects a signature over a different challenge's nonce, and burns the challenge", async () => {
		const keys = deriveAuthKeyPair(mnemonic);
		const a = await getChallenge(app);
		const b = await getChallenge(app);

		const res = await postJson(app, '/api/auth/verify', {
			challenge_id: b.challenge_id,
			signature: signAuthMessage(keys.privateKey, buildLoginMessage(a.nonce)),
		});
		expect(res.status).toBe(401);
		expect(await errorCode(res)).toBe('INVALID_SIGNATURE');

		// The failed attempt consumed challenge B — a correct signature now fails.
		const retry = await postJson(app, '/api/auth/verify', {
			challenge_id: b.challenge_id,
			signature: signAuthMessage(keys.privateKey, buildLoginMessage(b.nonce)),
		});
		expect(retry.status).toBe(401);
		expect(await errorCode(retry)).toBe('INVALID_CHALLENGE');
	});

	it('rejects a signature from the wrong keypair', async () => {
		const wrongKeys = deriveAuthKeyPair(generateMnemonic());
		const { challenge_id, nonce } = await getChallenge(app);
		const res = await postJson(app, '/api/auth/verify', {
			challenge_id,
			signature: signAuthMessage(wrongKeys.privateKey, buildLoginMessage(nonce)),
		});
		expect(res.status).toBe(401);
		expect(await errorCode(res)).toBe('INVALID_SIGNATURE');
	});

	it('accepts the unlock flow while already unlocked (stale-locked client)', async () => {
		const res = await loginViaAuthApi(app, mnemonic, { includeUnlockKey: true });
		expect(res.status).toBe(200);
		expect((await res.json()).data.token).toBeTypeOf('string');
	});
});
