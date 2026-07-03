import {
	buildPasswordLoginMessage,
	buildPasswordSetupMessage,
	derivePasswordKeyPair,
	generatePasswordSalt,
	signAuthMessage,
} from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetLoginThrottle } from '../src/routes/auth';
import { authHeader, loginViaAuthApi } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

let ctx: ServerTestContext;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(() => destroyTestContext(ctx));
beforeEach(() => resetLoginThrottle());

/** Drive the real challenge-response password login; returns the raw Response. */
async function passwordLogin(password: string): Promise<Response> {
	const challengeRes = await ctx.app.request('/api/auth/password-challenge', { method: 'POST' });
	if (challengeRes.status !== 200) return challengeRes;
	const { data } = (await challengeRes.json()) as {
		data: { challenge_id: string; nonce: string; salt: string };
	};
	const { privateKey } = await derivePasswordKeyPair(password, data.salt);
	const signature = signAuthMessage(privateKey, buildPasswordLoginMessage(data.nonce));
	return ctx.app.request('/api/auth/password-verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ challenge_id: data.challenge_id, signature }),
	});
}

/** Build the { salt, public_key, signature } enrollment body for a new password. */
async function enrollmentBody(password: string) {
	const salt = generatePasswordSalt();
	const { publicKeyHex, privateKey } = await derivePasswordKeyPair(password, salt);
	const signature = signAuthMessage(privateKey, buildPasswordSetupMessage(publicKeyHex, salt));
	return { salt, public_key: publicKeyHex, signature };
}

describe('password login (challenge-response)', () => {
	it('logs in with the correct password and mints a working session', async () => {
		const res = await passwordLogin(ctx.password);
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { token: string } };
		expect(typeof data.token).toBe('string');

		// The minted session works on a real /api route.
		const projects = await ctx.app.request('/api/projects', { headers: authHeader(data.token) });
		expect(projects.status).toBe(200);
	});

	it('rejects a wrong password with a generic 401', async () => {
		const res = await passwordLogin('not-the-password');
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('INVALID_CREDENTIALS');
	});

	it('never receives the password in the request body', async () => {
		// The verify body carries only challenge_id + signature — no password field.
		const challengeRes = await ctx.app.request('/api/auth/password-challenge', { method: 'POST' });
		const { data } = (await challengeRes.json()) as {
			data: { challenge_id: string; nonce: string; salt: string };
		};
		const { privateKey } = await derivePasswordKeyPair(ctx.password, data.salt);
		const body = {
			challenge_id: data.challenge_id,
			signature: signAuthMessage(privateKey, buildPasswordLoginMessage(data.nonce)),
		};
		expect(JSON.stringify(body)).not.toContain(ctx.password);
	});

	it('throttles after repeated failures, then locks with 429', async () => {
		// A well-formed but wrong signature fails verification without deriving a
		// key — the throttle counts failed verifies, so we avoid scrypt here (which
		// is intentionally slow and, under CI coverage instrumentation, would blow
		// the test timeout across six logins).
		const badSig = '00'.repeat(64);
		async function badVerify(): Promise<Response> {
			const ch = await ctx.app.request('/api/auth/password-challenge', { method: 'POST' });
			const { data } = (await ch.json()) as { data: { challenge_id: string } };
			return ctx.app.request('/api/auth/password-verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ challenge_id: data.challenge_id, signature: badSig }),
			});
		}
		for (let i = 0; i < 5; i++) {
			expect((await badVerify()).status).toBe(401);
		}
		// The throttle short-circuits before verifying, so the next attempt is 429.
		const locked = await badVerify();
		expect(locked.status).toBe(429);
		const body = (await locked.json()) as { error: { code: string } };
		expect(body.error.code).toBe('TOO_MANY_ATTEMPTS');
	});
});

describe('password enrollment / change (POST /api/auth/password)', () => {
	it('requires a session or password-setup token', async () => {
		const res = await ctx.app.request('/api/auth/password', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(await enrollmentBody('whatever')),
		});
		expect(res.status).toBe(401);
	});

	it('changes the password when authenticated with a session, and rotates login', async () => {
		// Snapshot the seeded verifier so we can restore it by DB write afterward —
		// re-enrolling would cost another slow scrypt derivation.
		const orig = (
			await ctx.db.query<{ password_salt: string; password_public_key: string }>(
				`SELECT password_salt, password_public_key FROM users WHERE is_superuser = true LIMIT 1`,
			)
		).rows[0];

		const newPassword = 'a-brand-new-password';
		const res = await ctx.app.request('/api/auth/password', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeader(ctx.token) },
			body: JSON.stringify(await enrollmentBody(newPassword)),
		});
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { token: string } };
		expect(typeof data.token).toBe('string');

		// New password now logs in; the seeded one no longer does.
		expect((await passwordLogin(newPassword)).status).toBe(200);
		resetLoginThrottle();
		expect((await passwordLogin(ctx.password)).status).toBe(401);

		// Restore the seeded verifier so later tests are unaffected (no scrypt).
		await ctx.db.query(
			`UPDATE users SET password_salt = $1, password_public_key = $2 WHERE is_superuser = true`,
			[orig.password_salt, orig.password_public_key],
		);
	});

	it('lets the master key (mnemonic) reset a forgotten password without a session', async () => {
		// The mnemonic flow returns a password-setup-scoped token (not a session)...
		const verifyRes = await loginViaAuthApi(ctx.app, ctx.mnemonic);
		expect(verifyRes.status).toBe(200);
		const { data: verifyData } = (await verifyRes.json()) as { data: { token: string } };
		const scopedToken = verifyData.token;

		// ...which cannot act as a session on a general route...
		const blocked = await ctx.app.request('/api/projects', { headers: authHeader(scopedToken) });
		expect(blocked.status).toBe(401);

		// ...but CAN set a new password, which then logs in.
		const recovered = 'recovered-via-master-key';
		const setRes = await ctx.app.request('/api/auth/password', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeader(scopedToken) },
			body: JSON.stringify(await enrollmentBody(recovered)),
		});
		expect(setRes.status).toBe(200);
		resetLoginThrottle();
		expect((await passwordLogin(recovered)).status).toBe(200);
	});
});

describe('GET /api/status passwordSet', () => {
	it('reports passwordSet true once a verifier is enrolled', async () => {
		const res = await ctx.app.request('/api/status');
		const body = (await res.json()) as { masterKeyState: string; passwordSet: boolean };
		expect(body.masterKeyState).toBe('unlocked');
		expect(body.passwordSet).toBe(true);
	});
});
