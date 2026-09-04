import { randomBytes } from 'node:crypto';
import {
	checkSsoTokenFreshness,
	parseIssuerPublicKeys,
	parseSsoToken,
	SSO_TOKEN_CLOCK_SKEW_SECONDS,
	type SsoTokenPayload,
	verifySsoTokenSignature,
} from '@hezo/shared';
import type { SsoConfig } from '../config/types';
import { BoundedMap } from '../lib/bounded-map';

/**
 * Verifying an issuer's assertion, and holding a verified identity across an
 * unlock.
 *
 * The two halves exist for the same reason. A new process starts locked by
 * default, though a supervised update may restore the key through its in-memory
 * IPC handoff and deliberate one-shot `--master-key` or `HEZO_MASTER_KEY` input
 * may inject it at startup. While locked, Hezo cannot mint a session because the
 * session key derives from the master key, so a token whose whole life is a
 * minute cannot also wait for someone to find twelve words. The token is
 * verified on arrival and what survives is a handle: proof that this identity
 * was asserted, and nothing else. It carries no key material and unlocks nothing.
 */

/**
 * Issuer keys, parsed once per distinct configured list.
 *
 * The list is validated at startup, so a parse failure here means the config was
 * replaced with something invalid at runtime. Failing to an empty map makes every
 * token fail closed on an unknown key rather than falling back to anything.
 */
let issuerKeyCache: { source: string; keys: Map<string, string> } | null = null;

function issuerKeys(config: SsoConfig): Map<string, string> {
	if (issuerKeyCache?.source !== config.issuerPublicKey) {
		const parsed = parseIssuerPublicKeys(config.issuerPublicKey);
		issuerKeyCache = {
			source: config.issuerPublicKey,
			keys: parsed.ok ? parsed.keys : new Map(),
		};
	}
	return issuerKeyCache.keys;
}

/**
 * Token ids already spent.
 *
 * Bounded two ways, because either alone is insufficient: an entry is dead once
 * the token it names could no longer be accepted anyway, and the map itself is
 * capped so a flood of distinct ids evicts rather than grows. Eviction is safe -
 * a token old enough to be evicted under the cap has to outlive its own window
 * to be worth replaying, and the window is a minute.
 *
 * In memory only. Every new process drops it and starts locked by default. A
 * supervised update may restore the master key through its in-memory IPC
 * handoff, while deliberate one-shot `--master-key` or `HEZO_MASTER_KEY` input
 * may inject the key at startup; neither path restores this replay cache.
 */
const REPLAY_CACHE_MAX_ENTRIES = 1024;
const replayCache = new BoundedMap<string, number>(REPLAY_CACHE_MAX_ENTRIES);

/**
 * Verified identities waiting for an unlock.
 *
 * Single-use and short-lived: long enough to fetch a recovery phrase, far too
 * short to be worth capturing. Capped as well as timed, so an instance left
 * locked while tokens arrive evicts rather than grows. There is no lock event to
 * clear these on, so the expiry is the bound that matters.
 */
const HANDLE_TTL_MS = 10 * 60_000;
const HANDLE_MAX_ENTRIES = 32;
const handles = new BoundedMap<string, { subject: string; expiresAtMs: number }>(
	HANDLE_MAX_ENTRIES,
);

/**
 * Brute-force throttle, separate from the password login's.
 *
 * Deliberately shorter than that one. Where SSO is configured it is the only way
 * in, and the password throttle's hour-long backoff would be a long time to be
 * locked out of your own instance.
 *
 * The length matters less than the ordering, though: callers check this only
 * AFTER an attempt has failed to verify, so something that verifies is let
 * through however hot the counter is. That is what stops a stream of rubbish
 * from anyone who can reach the gate denying the owner their own instance -
 * a shorter backoff alone would only have made the outage shorter.
 */
const SSO_MAX_ATTEMPTS = 10;
const SSO_LOCKOUT_MS = 30_000;
const SSO_MAX_LOCKOUT_MS = 5 * 60_000;
const ssoThrottle = { failures: 0, lockedUntil: 0 };

export type SsoFailureReason =
	| 'MALFORMED_TOKEN'
	| 'UNKNOWN_KEY'
	| 'BAD_SIGNATURE'
	| 'WRONG_AUDIENCE'
	| 'EXPIRED'
	| 'NOT_YET_VALID'
	| 'LIFETIME_TOO_LONG'
	| 'REPLAYED'
	| 'UNKNOWN_SUBJECT';

export type SsoVerification =
	| { ok: true; payload: SsoTokenPayload }
	| { ok: false; reason: SsoFailureReason };

/**
 * Check an assertion against the configured issuer, failing closed at each step.
 *
 * The reason is for the server's own log. Callers answer the client with one
 * undifferentiated failure: which step rejected the token would otherwise tell
 * whoever is probing whether they have the right audience, the right subject or
 * merely the wrong clock.
 *
 * The token id is spent only once everything else has passed, so a token that
 * fails for any other reason can still be presented again by its rightful owner.
 */
export function verifySsoAssertion(
	token: string,
	config: SsoConfig,
	nowMs: number,
): SsoVerification {
	const parsed = parseSsoToken(token);
	if (!parsed) return { ok: false, reason: 'MALFORMED_TOKEN' };

	const publicKeyHex = issuerKeys(config).get(parsed.payload.kid);
	if (!publicKeyHex) return { ok: false, reason: 'UNKNOWN_KEY' };

	if (!verifySsoTokenSignature(parsed.payload, parsed.signatureHex, publicKeyHex)) {
		return { ok: false, reason: 'BAD_SIGNATURE' };
	}

	if (parsed.payload.aud !== config.audience) return { ok: false, reason: 'WRONG_AUDIENCE' };

	const nowSeconds = Math.floor(nowMs / 1000);
	const freshness = checkSsoTokenFreshness(parsed.payload, nowSeconds);
	if (freshness === 'expired') return { ok: false, reason: 'EXPIRED' };
	if (freshness === 'not-yet-valid') return { ok: false, reason: 'NOT_YET_VALID' };
	if (freshness === 'lifetime-too-long') return { ok: false, reason: 'LIFETIME_TOO_LONG' };

	const seenUntil = replayCache.get(parsed.payload.jti);
	if (seenUntil !== undefined && seenUntil > nowMs) return { ok: false, reason: 'REPLAYED' };

	if (parsed.payload.sub !== config.ownerSubject) return { ok: false, reason: 'UNKNOWN_SUBJECT' };

	// Held strictly LONGER than the token stays presentable, not exactly as long.
	// The freshness check works in whole seconds and expires only once the clock
	// passes `exp + skew`, so an entry timed to that same instant lapses while the
	// token it names is still being accepted - a one-second hole in which a spent
	// token is takeable again. The extra second closes it.
	replayCache.set(
		parsed.payload.jti,
		(parsed.payload.exp + SSO_TOKEN_CLOCK_SKEW_SECONDS + 1) * 1000,
	);
	return { ok: true, payload: parsed.payload };
}

/** Park a verified identity until the instance is unlocked. */
export function issueSsoHandle(
	subject: string,
	nowMs: number,
): { handle: string; expiresInSeconds: number } {
	const handle = randomBytes(32).toString('hex');
	handles.set(handle, { subject, expiresAtMs: nowMs + HANDLE_TTL_MS });
	return { handle, expiresInSeconds: Math.floor(HANDLE_TTL_MS / 1000) };
}

/** Redeem a handle exactly once, returning the subject it vouched for. */
export function consumeSsoHandle(handle: string, nowMs: number): string | null {
	const held = handles.get(handle);
	if (!held) return null;
	handles.delete(handle);
	return held.expiresAtMs > nowMs ? held.subject : null;
}

export function ssoLockRemainingMs(nowMs: number): number {
	return ssoThrottle.lockedUntil > nowMs ? ssoThrottle.lockedUntil - nowMs : 0;
}

export function recordSsoFailure(nowMs: number): void {
	ssoThrottle.failures += 1;
	if (ssoThrottle.failures >= SSO_MAX_ATTEMPTS) {
		const overage = ssoThrottle.failures - SSO_MAX_ATTEMPTS;
		const backoff = Math.min(SSO_LOCKOUT_MS * 2 ** overage, SSO_MAX_LOCKOUT_MS);
		ssoThrottle.lockedUntil = nowMs + backoff;
	}
}

export function resetSsoThrottle(): void {
	ssoThrottle.failures = 0;
	ssoThrottle.lockedUntil = 0;
}

/** Exported for tests: these stores are module-global, so specs start from empty. */
export function resetSsoState(): void {
	resetSsoThrottle();
	replayCache.clear();
	handles.clear();
	issuerKeyCache = null;
}
