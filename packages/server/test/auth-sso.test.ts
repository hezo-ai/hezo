import {
	buildSsoTokenMessage,
	deriveAuthKeyPair,
	encodeSsoToken,
	generateMnemonic,
	SSO_TOKEN_CLOCK_SKEW_SECONDS,
	type SsoTokenPayload,
	signAuthMessage,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRuntimeConfig, runtimeConfig, setRuntimeConfig } from '../src/config/runtime';
import type { HezoConfig, SsoConfig } from '../src/config/types';
import type { Env } from '../src/lib/types';
import {
	consumeSsoHandle,
	issueSsoHandle,
	resetSsoState,
	verifySsoAssertion,
} from '../src/services/sso';
import { authHeader, loginViaAuthApi, restartTestApp } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

const ISSUER = deriveAuthKeyPair(generateMnemonic());
const OTHER_ISSUER = deriveAuthKeyPair(generateMnemonic());
const OWNER = '9f1cb2d4-0000-4000-8000-000000000001';
const AUDIENCE = 'alice.control.example';

const SSO: SsoConfig = {
	issuerUrl: 'https://control.example',
	issuerPublicKey: `k1:${ISSUER.publicKeyHex}`,
	ownerSubject: OWNER,
	audience: AUDIENCE,
};

let jti = 0;

function payload(overrides: Partial<SsoTokenPayload> = {}): SsoTokenPayload {
	const iat = Math.floor(Date.now() / 1000);
	return {
		kid: 'k1',
		aud: AUDIENCE,
		sub: OWNER,
		jti: `jti-${jti++}`,
		iat,
		exp: iat + 60,
		...overrides,
	};
}

function mint(p: SsoTokenPayload, key = ISSUER): string {
	return encodeSsoToken(p, signAuthMessage(key.privateKey, buildSsoTokenMessage(p)));
}

function withSso(sso: SsoConfig | null): void {
	setRuntimeConfig({ ...runtimeConfig(), sso } as HezoConfig);
}

describe('verifySsoAssertion', () => {
	beforeEach(() => resetSsoState());

	it('accepts an assertion from the configured issuer', () => {
		const result = verifySsoAssertion(mint(payload()), SSO, Date.now());
		expect(result.ok).toBe(true);
	});

	// Each step is checked here, where the reason is visible. The route collapses
	// them all to one code so a prober learns nothing from which one fired.
	it.each<[string, () => string, string]>([
		['a token that is not a token', () => 'not-a-token', 'MALFORMED_TOKEN'],
		['an unlisted key id', () => mint(payload({ kid: 'k9' })), 'UNKNOWN_KEY'],
		['a signature from another key', () => mint(payload(), OTHER_ISSUER), 'BAD_SIGNATURE'],
		[
			'an audience for another instance',
			() => mint(payload({ aud: 'bob.control.example' })),
			'WRONG_AUDIENCE',
		],
		[
			'a subject that is not the owner',
			() => mint(payload({ sub: 'someone-else' })),
			'UNKNOWN_SUBJECT',
		],
	])('rejects %s', (_label, build, reason) => {
		const result = verifySsoAssertion(build(), SSO, Date.now());
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe(reason);
	});

	it('rejects a token whose window has passed', () => {
		const iat = Math.floor(Date.now() / 1000) - 600;
		const result = verifySsoAssertion(mint(payload({ iat, exp: iat + 60 })), SSO, Date.now());
		expect(!result.ok && result.reason).toBe('EXPIRED');
	});

	it('rejects a token minted for the future', () => {
		const iat = Math.floor(Date.now() / 1000) + 600;
		const result = verifySsoAssertion(mint(payload({ iat, exp: iat + 60 })), SSO, Date.now());
		expect(!result.ok && result.reason).toBe('NOT_YET_VALID');
	});

	it('rejects an over-wide window even when it is current', () => {
		const iat = Math.floor(Date.now() / 1000);
		const result = verifySsoAssertion(mint(payload({ iat, exp: iat + 3600 })), SSO, Date.now());
		expect(!result.ok && result.reason).toBe('LIFETIME_TOO_LONG');
	});

	it('accepts a token exactly once', () => {
		const token = mint(payload());
		expect(verifySsoAssertion(token, SSO, Date.now()).ok).toBe(true);
		const replay = verifySsoAssertion(token, SSO, Date.now());
		expect(!replay.ok && replay.reason).toBe('REPLAYED');
	});

	// A token id is spent only on success, so a failure for any other reason
	// leaves its rightful owner able to present it again.
	it('does not spend the id of a token it rejected', () => {
		const p = payload();
		expect(verifySsoAssertion(mint(p, OTHER_ISSUER), SSO, Date.now()).ok).toBe(false);
		expect(verifySsoAssertion(mint(p), SSO, Date.now()).ok).toBe(true);
	});

	// The id must be remembered for exactly as long as a token carrying it could
	// still be presented, and no longer - otherwise the cache either misses a
	// replay or grows without bound.
	it('holds an id while its token is still presentable, then forgets it', () => {
		const now = Date.now();
		const first = payload();
		expect(verifySsoAssertion(mint(first), SSO, now).ok).toBe(true);

		// A fresh token reusing the id, while the original could still be replayed.
		const withinMs = first.exp * 1000;
		const withinSeconds = Math.floor(withinMs / 1000) - 1;
		const held = verifySsoAssertion(
			mint(payload({ jti: first.jti, iat: withinSeconds, exp: withinSeconds + 60 })),
			SSO,
			withinMs,
		);
		expect(!held.ok && held.reason).toBe('REPLAYED');

		// The same again, once the original's window and its skew have both passed.
		const afterMs = (first.exp + SSO_TOKEN_CLOCK_SKEW_SECONDS) * 1000 + 2000;
		const afterSeconds = Math.floor(afterMs / 1000);
		const freed = verifySsoAssertion(
			mint(payload({ jti: first.jti, iat: afterSeconds, exp: afterSeconds + 60 })),
			SSO,
			afterMs,
		);
		expect(freed.ok).toBe(true);
	});
});

describe('SSO handles', () => {
	beforeEach(() => resetSsoState());

	it('redeems exactly once', () => {
		const { handle } = issueSsoHandle(OWNER, Date.now());
		expect(consumeSsoHandle(handle, Date.now())).toBe(OWNER);
		expect(consumeSsoHandle(handle, Date.now())).toBeNull();
	});

	it('expires, and is spent by the attempt either way', () => {
		const now = Date.now();
		const { handle, expiresInSeconds } = issueSsoHandle(OWNER, now);
		expect(consumeSsoHandle(handle, now + expiresInSeconds * 1000 + 1)).toBeNull();
		expect(consumeSsoHandle(handle, now)).toBeNull();
	});

	it('is unguessable', () => {
		expect(issueSsoHandle(OWNER, Date.now()).handle).toMatch(/^[0-9a-f]{64}$/);
		expect(consumeSsoHandle('0'.repeat(64), Date.now())).toBeNull();
	});
});

describe('POST /api/auth/sso on an unlocked instance', () => {
	let ctx: ServerTestContext;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(() => destroyTestContext(ctx));
	beforeEach(() => {
		resetSsoState();
		withSso(SSO);
	});
	afterEach(() => resetRuntimeConfig());

	async function post(path: string, body: unknown): Promise<Response> {
		return await ctx.app.request(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	it('mints a session a protected route accepts', async () => {
		const res = await post('/api/auth/sso', { token: mint(payload()) });
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { locked: boolean; token: string } };
		expect(data.locked).toBe(false);

		const me = await ctx.app.request('/api/me', { headers: authHeader(data.token) });
		expect(me.status).toBe(200);
	});

	// The reason a token failed is the server's business, not a prober's.
	it.each<[string, () => string]>([
		['an audience for another instance', () => mint(payload({ aud: 'bob.control.example' }))],
		['a subject that is not the owner', () => mint(payload({ sub: 'someone-else' }))],
		['a signature from another key', () => mint(payload(), OTHER_ISSUER)],
		['an unlisted key id', () => mint(payload({ kid: 'k9' }))],
	])('answers one undifferentiated failure for %s', async (_label, build) => {
		const res = await post('/api/auth/sso', { token: build() });
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_TOKEN');
	});

	it('refuses a token it has already accepted', async () => {
		const token = mint(payload());
		expect((await post('/api/auth/sso', { token })).status).toBe(200);
		expect((await post('/api/auth/sso', { token })).status).toBe(401);
	});

	it('throttles a run of failures, and a valid token clears it', async () => {
		for (let i = 0; i < 10; i++) await post('/api/auth/sso', { token: 'rubbish' });
		const throttled = await post('/api/auth/sso', { token: mint(payload()) });
		expect(throttled.status).toBe(429);

		resetSsoState();
		expect((await post('/api/auth/sso', { token: mint(payload()) })).status).toBe(200);
	});

	it('rejects a body with no token', async () => {
		expect((await post('/api/auth/sso', {})).status).toBe(400);
	});

	it('is absent entirely when no issuer is configured', async () => {
		withSso(null);
		expect((await post('/api/auth/sso', { token: mint(payload()) })).status).toBe(404);
		expect((await post('/api/auth/sso/session', { handle: 'x' })).status).toBe(404);
	});
});

describe('POST /api/auth/sso on a locked instance', () => {
	let ctx: ServerTestContext;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(() => destroyTestContext(ctx));
	beforeEach(() => {
		resetSsoState();
		withSso(SSO);
	});
	afterEach(() => resetRuntimeConfig());

	/** A fresh worker over the same data directory, which comes up locked. */
	async function bootLocked() {
		const restarted = await restartTestApp(ctx.db, ctx.dataDir);
		expect(restarted.masterKeyManager.getState()).toBe('locked');
		return restarted;
	}

	async function post(target: Hono<Env>, path: string, body: unknown): Promise<Response> {
		return await target.request(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	// The behaviour the whole two-phase shape exists to preserve.
	it('hands back a handle and stays locked', async () => {
		const restarted = await bootLocked();
		const res = await post(restarted.app, '/api/auth/sso', { token: mint(payload()) });
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { locked: boolean; handle: string } };
		expect(data.locked).toBe(true);
		expect(data.handle).toMatch(/^[0-9a-f]{64}$/);
		expect(restarted.masterKeyManager.getState()).toBe('locked');
		// No session came back, and none can be redeemed while still locked.
		expect(data).not.toHaveProperty('token');
		const early = await post(restarted.app, '/api/auth/sso/session', { handle: data.handle });
		expect(early.status).toBe(401);
	});

	it('redeems the handle for a working session once the phrase is supplied', async () => {
		const restarted = await bootLocked();
		const first = await post(restarted.app, '/api/auth/sso', { token: mint(payload()) });
		const { handle } = ((await first.json()) as { data: { handle: string } }).data;

		const unlock = await loginViaAuthApi(restarted.app, ctx.mnemonic, { includeUnlockKey: true });
		expect(unlock.status).toBe(200);
		expect(restarted.masterKeyManager.getState()).toBe('unlocked');

		const second = await post(restarted.app, '/api/auth/sso/session', { handle });
		expect(second.status).toBe(200);
		const { token } = ((await second.json()) as { data: { token: string } }).data;
		const me = await restarted.app.request('/api/me', { headers: authHeader(token) });
		expect(me.status).toBe(200);

		// Single use: the same handle buys nothing a second time.
		expect((await post(restarted.app, '/api/auth/sso/session', { handle })).status).toBe(401);
	});

	it('rejects a handle nobody issued', async () => {
		const restarted = await bootLocked();
		await loginViaAuthApi(restarted.app, ctx.mnemonic, { includeUnlockKey: true });
		const res = await post(restarted.app, '/api/auth/sso/session', { handle: '0'.repeat(64) });
		expect(res.status).toBe(401);
	});
});

describe('GET /api/status', () => {
	let ctx: ServerTestContext;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(() => destroyTestContext(ctx));
	afterEach(() => resetRuntimeConfig());

	async function status(): Promise<Record<string, unknown>> {
		const res = await ctx.app.request('/api/status');
		expect(res.status).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	}

	it('names the issuer, pre-auth, so the gate knows what to offer', async () => {
		withSso(SSO);
		expect((await status()).sso).toEqual({ issuer_url: SSO.issuerUrl });
	});

	// An ordinary instance's payload is byte-identical to before this existed.
	it('omits the field entirely when no issuer is configured', async () => {
		withSso(null);
		expect(Object.hasOwn(await status(), 'sso')).toBe(false);
	});

	// A deployer that pins limits has not given the instance somewhere to sign in.
	it('does not infer an issuer from a policy being configured', async () => {
		const base = runtimeConfig();
		setRuntimeConfig({
			...base,
			sso: null,
			policy: { managedBy: 'Acme Cloud', manageUrl: 'https://acme.example', pinned: {} },
		} as HezoConfig);
		expect(Object.hasOwn(await status(), 'sso')).toBe(false);
	});

	// Only the URL the browser is about to be sent to; never the matching material.
	it('never returns the accepted keys, the owner subject or the audience', async () => {
		withSso(SSO);
		const body = JSON.stringify(await status());
		expect(body).not.toContain(ISSUER.publicKeyHex);
		expect(body).not.toContain(OWNER);
		expect(body).not.toContain(AUDIENCE);
	});
});
