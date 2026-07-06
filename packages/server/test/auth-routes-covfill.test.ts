import {
	buildLoginMessage,
	buildPasswordLoginMessage,
	buildPasswordSetupMessage,
	buildSetupMessage,
	DEFAULT_TEAM_ID,
	deriveAuthKeyPair,
	derivePasswordKeyPair,
	deriveUnlockKey,
	generateMnemonic,
	generatePasswordSalt,
	signAuthMessage,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { getSystemMeta, INSTANCE_BASE_URL_KEY } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { resetLoginThrottle } from '../src/routes/auth';
import { safeClose } from './helpers';
import { authHeader, createUnsetTestApp, loginViaAuthApi, restartTestApp } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function postJson(
	app: Hono<Env>,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return app.request(path, {
		method: 'POST',
		headers: { ...JSON_HEADERS, ...headers },
		body: JSON.stringify(body),
	});
}

async function errorCode(res: Response): Promise<string> {
	return ((await res.json()) as { error: { code: string } }).error.code;
}

/** Build the { salt, public_key, signature } enrollment body for a new password. */
async function enrollmentBody(password: string) {
	const salt = generatePasswordSalt();
	const { publicKeyHex, privateKey } = await derivePasswordKeyPair(password, salt);
	const signature = signAuthMessage(privateKey, buildPasswordSetupMessage(publicKeyHex, salt));
	return { salt, public_key: publicKeyHex, signature };
}

describe('fresh-boot lifecycle: setup, locked guards, first password enrollment', () => {
	let app: Hono<Env>;
	let db: Db;
	let masterKeyManager: MasterKeyManager;
	let dataDir: string;
	const mnemonic = generateMnemonic();
	const keys = deriveAuthKeyPair(mnemonic);
	const unlockKey = deriveUnlockKey(mnemonic);
	const password = 'covfill-first-password';

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

	it('rejects a non-JSON setup body with 400', async () => {
		const res = await app.request('/api/auth/setup', {
			method: 'POST',
			headers: JSON_HEADERS,
			body: 'not json at all',
		});
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('INVALID_REQUEST');
	});

	it('password endpoints report LOCKED while no key is set (state unset)', async () => {
		const challenge = await app.request('/api/auth/password-challenge', { method: 'POST' });
		expect(challenge.status).toBe(401);
		expect(await errorCode(challenge)).toBe('LOCKED');

		const verify = await postJson(app, '/api/auth/password-verify', {
			challenge_id: 'x',
			signature: '00'.repeat(64),
		});
		expect(verify.status).toBe(401);
		expect(await errorCode(verify)).toBe('LOCKED');

		const set = await postJson(app, '/api/auth/password', await enrollmentBody('irrelevant'));
		expect(set.status).toBe(401);
		expect(await errorCode(set)).toBe('LOCKED');
	});

	it('enrolls, captures the instance base URL, and seeds the superuser into the default team', async () => {
		const res = await postJson(app, '/api/auth/setup', setupBody());
		expect(res.status).toBe(200);
		const { token } = ((await res.json()) as { data: { token: string } }).data;
		expect(typeof token).toBe('string');
		expect(masterKeyManager.getState()).toBe('unlocked');

		// The base URL is captured from the request origin on first enrollment.
		const baseUrl = await getSystemMeta(db, INSTANCE_BASE_URL_KEY);
		expect(baseUrl).toBeTruthy();
		expect(baseUrl).toContain('localhost');

		// A superuser was created and joined to the default (HQ) team as admin.
		const superuser = await db.query<{ id: string }>(
			'SELECT id FROM users WHERE is_superuser = true',
		);
		expect(superuser.rows).toHaveLength(1);
		const membership = await db.query<{ role: string }>(
			`SELECT mu.role FROM members m
			 JOIN member_users mu ON mu.id = m.id
			 WHERE mu.user_id = $1 AND m.team_id = $2`,
			[superuser.rows[0].id, DEFAULT_TEAM_ID],
		);
		expect(membership.rows).toHaveLength(1);
		expect(membership.rows[0].role).toBe('admin');
	});

	it('returns 409 when enrollment loses the race after the state check', async () => {
		// The route's state gate sees 'unset' but the manager is already enrolled:
		// masterKeyManager.setup() must refuse and the route must 409.
		const spy = vi.spyOn(masterKeyManager, 'getState').mockReturnValueOnce('unset');
		try {
			const res = await postJson(app, '/api/auth/setup', setupBody());
			expect(res.status).toBe(409);
			expect(await errorCode(res)).toBe('ALREADY_SET');
		} finally {
			spy.mockRestore();
		}
	});

	it('password-challenge is 409 PASSWORD_NOT_SET before a verifier exists', async () => {
		const res = await app.request('/api/auth/password-challenge', { method: 'POST' });
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('PASSWORD_NOT_SET');
	});

	it('password-verify consumes the challenge, then reports PASSWORD_NOT_SET', async () => {
		const challengeRes = await app.request('/api/auth/challenge', { method: 'POST' });
		const { challenge_id } = (
			(await challengeRes.json()) as {
				data: { challenge_id: string };
			}
		).data;
		const res = await postJson(app, '/api/auth/password-verify', {
			challenge_id,
			signature: '00'.repeat(64),
		});
		expect(res.status).toBe(409);
		expect(await errorCode(res)).toBe('PASSWORD_NOT_SET');
	});

	it('password-verify rejects malformed bodies and unknown challenges', async () => {
		const notJson = await app.request('/api/auth/password-verify', {
			method: 'POST',
			headers: JSON_HEADERS,
			body: '{{nope',
		});
		expect(notJson.status).toBe(400);
		expect(await errorCode(notJson)).toBe('INVALID_REQUEST');

		for (const body of [
			{},
			{ challenge_id: '', signature: '00'.repeat(64) },
			{ challenge_id: 'x', signature: 'not-hex' },
		]) {
			const res = await postJson(app, '/api/auth/password-verify', body);
			expect(res.status).toBe(400);
			expect(await errorCode(res)).toBe('INVALID_REQUEST');
		}

		const unknown = await postJson(app, '/api/auth/password-verify', {
			challenge_id: '00000000-0000-4000-8000-000000000000',
			signature: '00'.repeat(64),
		});
		expect(unknown.status).toBe(401);
		expect(await errorCode(unknown)).toBe('INVALID_CHALLENGE');
	});

	it('POST /auth/password rejects missing and invalid bearers', async () => {
		const missing = await postJson(app, '/api/auth/password', await enrollmentBody('nope'));
		expect(missing.status).toBe(401);
		expect(await errorCode(missing)).toBe('UNAUTHORIZED');

		const garbage = await postJson(app, '/api/auth/password', await enrollmentBody('nope'), {
			Authorization: 'Bearer not-a-jwt',
		});
		expect(garbage.status).toBe(401);
		expect(await errorCode(garbage)).toBe('UNAUTHORIZED');
	});

	it('POST /auth/password validates the body shape and the TOFU self-signature', async () => {
		const verifyRes = await loginViaAuthApi(app, mnemonic);
		expect(verifyRes.status).toBe(200);
		const setupToken = ((await verifyRes.json()) as { data: { token: string } }).data.token;

		const notJson = await app.request('/api/auth/password', {
			method: 'POST',
			headers: { ...JSON_HEADERS, ...authHeader(setupToken) },
			body: '][',
		});
		expect(notJson.status).toBe(400);
		expect(await errorCode(notJson)).toBe('INVALID_REQUEST');

		const badSalt = await postJson(
			app,
			'/api/auth/password',
			{ ...(await enrollmentBody('whatever')), salt: 'zz' },
			authHeader(setupToken),
		);
		expect(badSalt.status).toBe(400);
		expect(await errorCode(badSalt)).toBe('INVALID_REQUEST');

		// Signature is well-formed hex but signed over different material.
		const enrollment = await enrollmentBody('whatever');
		const badSig = await postJson(
			app,
			'/api/auth/password',
			{ ...enrollment, signature: '00'.repeat(64) },
			authHeader(setupToken),
		);
		expect(badSig.status).toBe(401);
		expect(await errorCode(badSig)).toBe('INVALID_SIGNATURE');

		// No verifier was stored by any of the failed attempts.
		const rows = await db.query('SELECT id FROM users WHERE password_public_key IS NOT NULL');
		expect(rows.rows).toHaveLength(0);
	});

	it('first enrollment mints a session and the password then logs in', async () => {
		const verifyRes = await loginViaAuthApi(app, mnemonic);
		const setupToken = ((await verifyRes.json()) as { data: { token: string } }).data.token;

		const res = await postJson(
			app,
			'/api/auth/password',
			await enrollmentBody(password),
			authHeader(setupToken),
		);
		expect(res.status).toBe(200);
		const session = ((await res.json()) as { data: { token: string } }).data.token;

		// The returned token is a real session.
		const projects = await app.request('/api/projects', { headers: authHeader(session) });
		expect(projects.status).toBe(200);

		// Full challenge-response password login now succeeds.
		const challengeRes = await app.request('/api/auth/password-challenge', { method: 'POST' });
		expect(challengeRes.status).toBe(200);
		const { challenge_id, nonce, salt } = (
			(await challengeRes.json()) as {
				data: { challenge_id: string; nonce: string; salt: string };
			}
		).data;
		const { privateKey } = await derivePasswordKeyPair(password, salt);
		const login = await postJson(app, '/api/auth/password-verify', {
			challenge_id,
			signature: signAuthMessage(privateKey, buildPasswordLoginMessage(nonce)),
		});
		expect(login.status).toBe(200);
		expect(((await login.json()) as { data: { token: string } }).data.token).toBeTypeOf('string');
	});

	it('after a restart the server is locked and requires the unlock key', async () => {
		const restarted = await restartTestApp(db, dataDir);
		expect(restarted.masterKeyManager.getState()).toBe('locked');

		// Valid login signature but no unlock key: distinct error so the client retries.
		const withoutKey = await loginViaAuthApi(restarted.app, mnemonic);
		expect(withoutKey.status).toBe(401);
		expect(await errorCode(withoutKey)).toBe('UNLOCK_KEY_REQUIRED');

		// A signature from the wrong keypair fails and burns the challenge.
		const wrongKeys = deriveAuthKeyPair(generateMnemonic());
		const challengeRes = await restarted.app.request('/api/auth/challenge', { method: 'POST' });
		const { challenge_id, nonce } = (
			(await challengeRes.json()) as {
				data: { challenge_id: string; nonce: string };
			}
		).data;
		const badSig = await postJson(restarted.app, '/api/auth/verify', {
			challenge_id,
			signature: signAuthMessage(wrongKeys.privateKey, buildLoginMessage(nonce)),
		});
		expect(badSig.status).toBe(401);
		expect(await errorCode(badSig)).toBe('INVALID_SIGNATURE');

		// The burned challenge is now invalid even with the right signature.
		const replay = await postJson(restarted.app, '/api/auth/verify', {
			challenge_id,
			signature: signAuthMessage(keys.privateKey, buildLoginMessage(nonce)),
		});
		expect(replay.status).toBe(401);
		expect(await errorCode(replay)).toBe('INVALID_CHALLENGE');

		expect(restarted.masterKeyManager.getState()).toBe('locked');

		// The correct unlock key unlocks.
		const withKey = await loginViaAuthApi(restarted.app, mnemonic, { includeUnlockKey: true });
		expect(withKey.status).toBe(200);
		expect(restarted.masterKeyManager.getState()).toBe('unlocked');
	});
});

describe('login throttle and password change on an enrolled server', () => {
	let ctx: ServerTestContext;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(() => destroyTestContext(ctx));
	beforeEach(() => resetLoginThrottle());

	/** One failed password-verify: real challenge, well-formed wrong signature. */
	async function badVerify(): Promise<Response> {
		const ch = await ctx.app.request('/api/auth/password-challenge', { method: 'POST' });
		const { challenge_id } = ((await ch.json()) as { data: { challenge_id: string } }).data;
		return postJson(ctx.app, '/api/auth/password-verify', {
			challenge_id,
			signature: '00'.repeat(64),
		});
	}

	/** Current-password proof for a session-authenticated change. */
	async function currentProof(password: string) {
		const ch = await ctx.app.request('/api/auth/password-challenge', { method: 'POST' });
		const { challenge_id, nonce, salt } = (
			(await ch.json()) as {
				data: { challenge_id: string; nonce: string; salt: string };
			}
		).data;
		const { privateKey } = await derivePasswordKeyPair(password, salt);
		return {
			current_challenge_id: challenge_id,
			current_signature: signAuthMessage(privateKey, buildPasswordLoginMessage(nonce)),
		};
	}

	it('locks out after repeated failures with TOO_MANY_ATTEMPTS', async () => {
		for (let i = 0; i < 5; i++) {
			const res = await badVerify();
			expect(res.status).toBe(401);
			expect(await errorCode(res)).toBe('INVALID_CREDENTIALS');
		}
		const locked = await badVerify();
		expect(locked.status).toBe(429);
		expect(await errorCode(locked)).toBe('TOO_MANY_ATTEMPTS');
	});

	it('the change endpoint honours the shared lockout with 429', async () => {
		for (let i = 0; i < 5; i++) expect((await badVerify()).status).toBe(401);

		const res = await postJson(
			ctx.app,
			'/api/auth/password',
			{
				...(await enrollmentBody('any-new-password')),
				current_challenge_id: 'irrelevant',
				current_signature: '00'.repeat(64),
			},
			authHeader(ctx.token),
		);
		expect(res.status).toBe(429);
		expect(await errorCode(res)).toBe('TOO_MANY_ATTEMPTS');
	});

	it('a session-authenticated change requires the current-password proof', async () => {
		const res = await postJson(
			ctx.app,
			'/api/auth/password',
			await enrollmentBody('sneaky'),
			authHeader(ctx.token),
		);
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('CURRENT_PASSWORD_REQUIRED');
	});

	it('rejects an unknown current challenge and a wrong current signature', async () => {
		const enrollment = await enrollmentBody('next-password');

		const unknown = await postJson(
			ctx.app,
			'/api/auth/password',
			{
				...enrollment,
				current_challenge_id: 'no-such-challenge',
				current_signature: '00'.repeat(64),
			},
			authHeader(ctx.token),
		);
		expect(unknown.status).toBe(401);
		expect(await errorCode(unknown)).toBe('INVALID_CHALLENGE');

		const ch = await ctx.app.request('/api/auth/password-challenge', { method: 'POST' });
		const { challenge_id } = ((await ch.json()) as { data: { challenge_id: string } }).data;
		const wrongSig = await postJson(
			ctx.app,
			'/api/auth/password',
			{
				...enrollment,
				current_challenge_id: challenge_id,
				current_signature: '00'.repeat(64),
			},
			authHeader(ctx.token),
		);
		expect(wrongSig.status).toBe(401);
		expect(await errorCode(wrongSig)).toBe('INVALID_CREDENTIALS');

		// The verifier never changed.
		const row = await ctx.db.query<{ password_salt: string }>(
			'SELECT password_salt FROM users WHERE is_superuser = true LIMIT 1',
		);
		expect(row.rows[0].password_salt).toBe(ctx.passwordSalt);
	});

	it('changes the password with a valid current proof and mints a fresh session', async () => {
		// Snapshot the seeded verifier to restore afterwards without re-deriving.
		const orig = (
			await ctx.db.query<{ password_salt: string; password_public_key: string }>(
				'SELECT password_salt, password_public_key FROM users WHERE is_superuser = true LIMIT 1',
			)
		).rows[0];

		const res = await postJson(
			ctx.app,
			'/api/auth/password',
			{
				...(await enrollmentBody('rotated-password')),
				...(await currentProof(ctx.password)),
			},
			authHeader(ctx.token),
		);
		expect(res.status).toBe(200);
		const session = ((await res.json()) as { data: { token: string } }).data.token;
		const projects = await ctx.app.request('/api/projects', { headers: authHeader(session) });
		expect(projects.status).toBe(200);

		// The stored verifier rotated.
		const row = await ctx.db.query<{ password_salt: string }>(
			'SELECT password_salt FROM users WHERE is_superuser = true LIMIT 1',
		);
		expect(row.rows[0].password_salt).not.toBe(orig.password_salt);

		await ctx.db.query(
			'UPDATE users SET password_salt = $1, password_public_key = $2 WHERE is_superuser = true',
			[orig.password_salt, orig.password_public_key],
		);
	});
});
