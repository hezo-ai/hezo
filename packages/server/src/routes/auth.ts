import {
	buildLoginMessage,
	buildPasswordLoginMessage,
	buildPasswordSetupMessage,
	buildSetupMessage,
	buildUnlockMessage,
	verifyAuthSignature,
} from '@hezo/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { runtimeConfig } from '../config/runtime';
import { requestOrigin } from '../lib/request-origin';
import { err, ok } from '../lib/response';
import {
	getSystemMeta,
	INSTANCE_BASE_URL_KEY,
	normalizeBaseUrl,
	setSystemMeta,
} from '../lib/system-meta';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import {
	resolvePasswordMutationUserId,
	signAdminJwt,
	signPasswordSetupToken,
} from '../middleware/auth';
import {
	getAdminPasswordVerifier,
	setAdminPasswordVerifier,
	verifyPasswordSignature,
} from '../services/password';
import {
	consumeSsoHandle,
	issueSsoHandle,
	recordSsoFailure,
	resetSsoThrottle,
	ssoLockRemainingMs,
	verifySsoAssertion,
} from '../services/sso';
import { ensureSuperuserId, getSuperuserId } from '../services/superuser';

const log = logger.child('routes');

const KEY_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;
const SALT_HEX = /^[0-9a-f]{32}$/;

// In-memory brute-force throttle for password login. Single admin, so one global
// counter suffices. Not persisted — a restart clears it, which is fine (a
// restart re-locks the instance behind the master key anyway).
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 60_000;
const loginThrottle = { failures: 0, lockedUntil: 0 };

function loginLockRemainingMs(now: number): number {
	return loginThrottle.lockedUntil > now ? loginThrottle.lockedUntil - now : 0;
}

function recordLoginFailure(now: number): void {
	loginThrottle.failures += 1;
	if (loginThrottle.failures >= LOGIN_MAX_ATTEMPTS) {
		// Exponential backoff past the threshold: 1m, 2m, 4m, … (capped at 1h).
		const overage = loginThrottle.failures - LOGIN_MAX_ATTEMPTS;
		const backoff = Math.min(LOGIN_LOCKOUT_MS * 2 ** overage, 60 * 60_000);
		loginThrottle.lockedUntil = now + backoff;
	}
}

/** Exported for tests: the throttle is module-global, so specs reset it to stay deterministic. */
export function resetLoginThrottle(): void {
	loginThrottle.failures = 0;
	loginThrottle.lockedUntil = 0;
}

export const authRoutes = new Hono<Env>();

// Challenge-response auth. The master-key mnemonic never reaches the server:
// the client derives an Ed25519 keypair (enrolled at setup, signs challenges
// thereafter) and an unlock key (transits only at setup and unlock — inside a
// signed payload — to root the server's at-rest encryption).

// Enrollment, first boot only: bind the auth public key and store the canary.
authRoutes.post('/auth/setup', async (c) => {
	let body: { public_key?: string; unlock_key?: string; signature?: string };
	try {
		body = await c.req.json();
	} catch {
		return err(c, 'INVALID_REQUEST', 'JSON body required', 400);
	}
	const { public_key, unlock_key, signature } = body;
	if (
		typeof public_key !== 'string' ||
		!KEY_HEX.test(public_key) ||
		typeof unlock_key !== 'string' ||
		!KEY_HEX.test(unlock_key) ||
		typeof signature !== 'string' ||
		!SIGNATURE_HEX.test(signature)
	) {
		return err(c, 'INVALID_REQUEST', 'public_key, unlock_key, and signature are required', 400);
	}

	const masterKeyManager = c.get('masterKeyManager');
	if (masterKeyManager.getState() !== 'unset') {
		return err(c, 'ALREADY_SET', 'Master key is already set', 409);
	}

	// Self-certifying enrollment (TOFU, the same trust level as any first-boot
	// credential): the signature proves possession of the private key matching
	// the submitted public key. Verified before anything is persisted.
	if (!verifyAuthSignature(public_key, buildSetupMessage(public_key, unlock_key), signature)) {
		return err(c, 'INVALID_SIGNATURE', 'Signature verification failed', 401);
	}

	const enrolled = await masterKeyManager.setup(c.get('db'), unlock_key, public_key);
	if (!enrolled) {
		return err(c, 'ALREADY_SET', 'Master key is already set', 409);
	}

	return issuePasswordSetupToken(c);
});

// Step 1 of login/unlock: a single-use nonce for the client to sign.
authRoutes.post('/auth/challenge', (c) => {
	if (c.get('masterKeyManager').getState() === 'unset') {
		return err(c, 'SETUP_REQUIRED', 'No master key set. Run setup first.', 409);
	}
	const { challengeId, nonce, expiresInSeconds } = c.get('authChallenges').issue();
	return ok(c, { challenge_id: challengeId, nonce, expires_in: expiresInSeconds });
});

// Step 2: verify the Ed25519 signature over the stored nonce and issue a
// short-lived password-setup token (the mnemonic unlocks + authorizes setting a
// password, but is not itself a session). The client signs
// buildUnlockMessage(nonce, unlock_key) when it includes the unlock key (server
// locked), buildLoginMessage(nonce) otherwise. The nonce is never echoed back —
// the message is reconstructed from the stored copy, so the signature is the
// sole authenticator.
authRoutes.post('/auth/verify', async (c) => {
	let body: { challenge_id?: string; signature?: string; unlock_key?: string };
	try {
		body = await c.req.json();
	} catch {
		return err(c, 'INVALID_REQUEST', 'JSON body required', 400);
	}
	const { challenge_id, signature, unlock_key } = body;
	// Shape-validate before consuming, so malformed junk can't burn a challenge.
	if (
		typeof challenge_id !== 'string' ||
		challenge_id.length === 0 ||
		typeof signature !== 'string' ||
		!SIGNATURE_HEX.test(signature) ||
		(unlock_key !== undefined && (typeof unlock_key !== 'string' || !KEY_HEX.test(unlock_key)))
	) {
		return err(c, 'INVALID_REQUEST', 'challenge_id and signature are required', 400);
	}

	const masterKeyManager = c.get('masterKeyManager');
	const db = c.get('db');
	if (masterKeyManager.getState() === 'unset') {
		return err(c, 'SETUP_REQUIRED', 'No master key set. Run setup first.', 409);
	}

	// Consume before verifying: a failed attempt burns the nonce, so one
	// challenge never absorbs more than a single signature guess.
	const challenge = c.get('authChallenges').consume(challenge_id);
	if (!challenge) {
		return err(c, 'INVALID_CHALLENGE', 'Unknown, expired, or already used challenge', 401);
	}

	const message =
		unlock_key !== undefined
			? buildUnlockMessage(challenge.nonce, unlock_key)
			: buildLoginMessage(challenge.nonce);
	if (!(await masterKeyManager.verifySignature(db, message, signature))) {
		return err(c, 'INVALID_SIGNATURE', 'Signature verification failed', 401);
	}

	if (masterKeyManager.getState() === 'locked' && unlock_key === undefined) {
		// Distinct from the middleware's LOCKED so the client can retry the
		// challenge dance with the unlock key included.
		return err(c, 'UNLOCK_KEY_REQUIRED', 'Server is locked; include unlock_key', 401);
	}

	// Runs even when already unlocked, so a client that believed the server was
	// locked (stale status) still succeeds — the canary check makes it a no-op.
	if (unlock_key !== undefined) {
		const unlocked = await masterKeyManager.unlock(db, unlock_key);
		if (!unlocked) {
			return err(c, 'INVALID_UNLOCK_KEY', 'Invalid unlock key', 401);
		}
	}

	return issuePasswordSetupToken(c);
});

// --- Password auth (challenge-response; password never leaves the browser) ----

// Login step 1: hand back a nonce to sign + the admin's salt so the client can
// re-derive its password keypair. 409 until a password verifier is enrolled.
authRoutes.post('/auth/password-challenge', async (c) => {
	const masterKeyManager = c.get('masterKeyManager');
	if (masterKeyManager.getState() !== 'unlocked') {
		return err(c, 'LOCKED', 'Server is locked. Provide master key to unlock.', 401);
	}
	const verifier = await getAdminPasswordVerifier(c.get('db'));
	if (!verifier) {
		return err(c, 'PASSWORD_NOT_SET', 'No password set. Set one via the master key.', 409);
	}
	const { challengeId, nonce, expiresInSeconds } = c.get('authChallenges').issue();
	return ok(c, {
		challenge_id: challengeId,
		nonce,
		salt: verifier.salt,
		expires_in: expiresInSeconds,
	});
});

// Login step 2: verify the signature over buildPasswordLoginMessage(nonce)
// against the stored verifier and mint a session JWT. Throttled globally.
authRoutes.post('/auth/password-verify', async (c) => {
	const masterKeyManager = c.get('masterKeyManager');
	const db = c.get('db');
	if (masterKeyManager.getState() !== 'unlocked') {
		return err(c, 'LOCKED', 'Server is locked. Provide master key to unlock.', 401);
	}

	const now = Date.now();
	const lockMs = loginLockRemainingMs(now);
	if (lockMs > 0) {
		return err(
			c,
			'TOO_MANY_ATTEMPTS',
			`Too many attempts. Try again in ${Math.ceil(lockMs / 1000)}s.`,
			429,
		);
	}

	let body: { challenge_id?: string; signature?: string };
	try {
		body = await c.req.json();
	} catch {
		return err(c, 'INVALID_REQUEST', 'JSON body required', 400);
	}
	const { challenge_id, signature } = body;
	if (
		typeof challenge_id !== 'string' ||
		challenge_id.length === 0 ||
		typeof signature !== 'string' ||
		!SIGNATURE_HEX.test(signature)
	) {
		return err(c, 'INVALID_REQUEST', 'challenge_id and signature are required', 400);
	}

	// Consume before verifying: one nonce absorbs a single guess.
	const challenge = c.get('authChallenges').consume(challenge_id);
	if (!challenge) {
		return err(c, 'INVALID_CHALLENGE', 'Unknown, expired, or already used challenge', 401);
	}

	const verifier = await getAdminPasswordVerifier(db);
	if (!verifier) {
		return err(c, 'PASSWORD_NOT_SET', 'No password set. Set one via the master key.', 409);
	}

	const ok_ = await verifyPasswordSignature(
		db,
		buildPasswordLoginMessage(challenge.nonce),
		signature,
	);
	if (!ok_) {
		recordLoginFailure(now);
		// Generic message: never reveal whether it was the user or the password.
		return err(c, 'INVALID_CREDENTIALS', 'Incorrect password', 401);
	}

	resetLoginThrottle();
	const token = await signAdminJwt(masterKeyManager, verifier.userId);
	return ok(c, { token }, 200);
});

// Set or change the password verifier. Public path but self-authenticating: the
// bearer must be a full session JWT (logged-in change) or a password-setup-scoped
// JWT (initial-set / recovery). The password never arrives — only the client-
// derived { salt, public_key } verifier plus a self-signature proving the client
// holds the matching private key. A session-authenticated change while a verifier
// is already enrolled must additionally prove the CURRENT password: a
// `/auth/password-challenge` nonce signed with the current-password keypair
// (`current_challenge_id` + `current_signature`), throttled like login so this
// endpoint can't be used as a password oracle. Setup-scoped bearers (master-key
// recovery) and first enrollment are exempt. Returns a fresh session so the
// caller is logged in with the password they just set.
authRoutes.post('/auth/password', async (c) => {
	const masterKeyManager = c.get('masterKeyManager');
	const db = c.get('db');
	if (masterKeyManager.getState() !== 'unlocked') {
		return err(c, 'LOCKED', 'Server is locked. Provide master key to unlock.', 401);
	}

	const header = c.req.header('Authorization');
	if (!header?.startsWith('Bearer ')) {
		return err(c, 'UNAUTHORIZED', 'Missing authorization header', 401);
	}
	const auth = await resolvePasswordMutationUserId(header.slice(7), db, masterKeyManager);
	if (!auth) {
		return err(c, 'UNAUTHORIZED', 'Invalid or expired token', 401);
	}
	const { userId, isSetupScoped } = auth;

	let body: {
		salt?: string;
		public_key?: string;
		signature?: string;
		current_challenge_id?: string;
		current_signature?: string;
	};
	try {
		body = await c.req.json();
	} catch {
		return err(c, 'INVALID_REQUEST', 'JSON body required', 400);
	}
	const { salt, public_key, signature, current_challenge_id, current_signature } = body;
	if (
		typeof salt !== 'string' ||
		!SALT_HEX.test(salt) ||
		typeof public_key !== 'string' ||
		!KEY_HEX.test(public_key) ||
		typeof signature !== 'string' ||
		!SIGNATURE_HEX.test(signature)
	) {
		return err(c, 'INVALID_REQUEST', 'salt, public_key, and signature are required', 400);
	}

	// A logged-in change (session bearer, verifier already enrolled) must prove
	// the current password before the verifier is replaced. Verified against the
	// OLD stored verifier, so this must run before setAdminPasswordVerifier.
	if (!isSetupScoped && (await getAdminPasswordVerifier(db))) {
		const now = Date.now();
		const lockMs = loginLockRemainingMs(now);
		if (lockMs > 0) {
			return err(
				c,
				'TOO_MANY_ATTEMPTS',
				`Too many attempts. Try again in ${Math.ceil(lockMs / 1000)}s.`,
				429,
			);
		}
		if (
			typeof current_challenge_id !== 'string' ||
			current_challenge_id.length === 0 ||
			typeof current_signature !== 'string' ||
			!SIGNATURE_HEX.test(current_signature)
		) {
			return err(
				c,
				'CURRENT_PASSWORD_REQUIRED',
				'Changing the password requires proof of the current password',
				400,
			);
		}
		// Consume before verifying: one nonce absorbs a single guess.
		const challenge = c.get('authChallenges').consume(current_challenge_id);
		if (!challenge) {
			return err(c, 'INVALID_CHALLENGE', 'Unknown, expired, or already used challenge', 401);
		}
		const currentOk = await verifyPasswordSignature(
			db,
			buildPasswordLoginMessage(challenge.nonce),
			current_signature,
		);
		if (!currentOk) {
			recordLoginFailure(now);
			return err(c, 'INVALID_CREDENTIALS', 'Incorrect password', 401);
		}
	}

	// TOFU self-signature: proves the client holds the private key for the verifier
	// it's enrolling. Password length/complexity is enforced client-side (the
	// server never sees the password).
	if (!verifyAuthSignature(public_key, buildPasswordSetupMessage(public_key, salt), signature)) {
		return err(c, 'INVALID_SIGNATURE', 'Signature verification failed', 401);
	}

	await setAdminPasswordVerifier(db, userId, { salt, publicKeyHex: public_key });
	resetLoginThrottle();
	const token = await signAdminJwt(masterKeyManager, userId);
	return ok(c, { token }, 200);
});

/**
 * Shared tail of setup/verify: capture base URL, ensure the superuser exists,
 * and mint a short-lived **password-setup token** (NOT a session). The mnemonic
 * only unlocks — proving master-key ownership lets the client set a password via
 * `POST /api/auth/password`, which is the only path that then mints a session.
 */
async function issuePasswordSetupToken(c: Context<Env>) {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	// Capture the public base URL of this instance from the URL the operator
	// used to reach it. Only when unset — a configured or previously captured
	// value is never clobbered (it stays editable in global settings). Awaited
	// so the settings page the operator lands on next reflects it.
	try {
		if (!(await getSystemMeta(db, INSTANCE_BASE_URL_KEY))) {
			const origin = normalizeBaseUrl(requestOrigin(c));
			if (origin) await setSystemMeta(db, INSTANCE_BASE_URL_KEY, origin);
		}
	} catch (e) {
		log.error('Failed to capture instance base URL:', e);
	}

	const token = await signPasswordSetupToken(masterKeyManager, await ensureSuperuserId(db));
	return ok(c, { token }, 200);
}

// --- Single sign-on from an external issuer -----------------------------------
//
// Two phases, because on a locked instance identity and session cannot be minted
// in the same breath: the session key derives from the master key, so there is
// nothing to sign with until someone supplies the phrase. A token good for a
// minute cannot wait for that, so the first phase verifies the assertion and
// parks it, the gate unlocks as it always would, and the second phase redeems
// the parked identity for an ordinary session.
//
// Neither phase accepts, stores or forwards key material. A locked instance that
// accepts a valid token is still locked.

/** One undifferentiated failure: which step rejected a token is the server's business. */
function ssoRejected(c: Context<Env>, now: number, reason: string) {
	recordSsoFailure(now);
	log.warn(`Rejected an SSO sign-in: ${reason}`);
	return err(c, 'INVALID_TOKEN', 'Sign-in token rejected', 401);
}

function ssoThrottled(c: Context<Env>, lockMs: number) {
	return err(
		c,
		'TOO_MANY_ATTEMPTS',
		`Too many attempts. Try again in ${Math.ceil(lockMs / 1000)}s.`,
		429,
	);
}

// Phase one. Answers either a session (already unlocked) or a handle to redeem
// once the gate has been satisfied.
authRoutes.post('/auth/sso', async (c) => {
	const config = runtimeConfig().sso;
	if (!config) return err(c, 'NOT_FOUND', 'Single sign-on is not configured', 404);

	const masterKeyManager = c.get('masterKeyManager');
	if (masterKeyManager.getState() === 'unset') {
		return err(c, 'SETUP_REQUIRED', 'This instance has not been set up yet', 409);
	}

	const now = Date.now();
	const lockMs = ssoLockRemainingMs(now);
	if (lockMs > 0) return ssoThrottled(c, lockMs);

	let body: { token?: string };
	try {
		body = await c.req.json();
	} catch {
		return err(c, 'INVALID_REQUEST', 'JSON body required', 400);
	}
	if (typeof body.token !== 'string' || body.token.length === 0) {
		return err(c, 'INVALID_REQUEST', 'token is required', 400);
	}

	const verification = verifySsoAssertion(body.token, config, now);
	if (!verification.ok) return ssoRejected(c, now, verification.reason);
	resetSsoThrottle();

	if (masterKeyManager.getState() !== 'unlocked') {
		const { handle, expiresInSeconds } = issueSsoHandle(verification.payload.sub, now);
		return ok(c, { locked: true, handle, expires_in: expiresInSeconds }, 200);
	}

	const userId = await getSuperuserId(c.get('db'));
	if (!userId) return err(c, 'SETUP_REQUIRED', 'This instance has not been set up yet', 409);
	return ok(c, { locked: false, token: await signAdminJwt(masterKeyManager, userId) }, 200);
});

// Phase two. Redeems a handle from phase one, once the instance is unlocked.
authRoutes.post('/auth/sso/session', async (c) => {
	const config = runtimeConfig().sso;
	if (!config) return err(c, 'NOT_FOUND', 'Single sign-on is not configured', 404);

	const masterKeyManager = c.get('masterKeyManager');
	if (masterKeyManager.getState() !== 'unlocked') {
		return err(c, 'LOCKED', 'Server is locked. Provide master key to unlock.', 401);
	}

	const now = Date.now();
	const lockMs = ssoLockRemainingMs(now);
	if (lockMs > 0) return ssoThrottled(c, lockMs);

	let body: { handle?: string };
	try {
		body = await c.req.json();
	} catch {
		return err(c, 'INVALID_REQUEST', 'JSON body required', 400);
	}
	if (typeof body.handle !== 'string' || body.handle.length === 0) {
		return err(c, 'INVALID_REQUEST', 'handle is required', 400);
	}

	const subject = consumeSsoHandle(body.handle, now);
	if (!subject) return ssoRejected(c, now, 'unknown, expired or already-used handle');
	// The configured owner can change between the two phases, and the handle must
	// not outlive the answer it was granted under.
	if (subject !== config.ownerSubject) return ssoRejected(c, now, 'handle is no longer the owner');

	const userId = await getSuperuserId(c.get('db'));
	if (!userId) return err(c, 'SETUP_REQUIRED', 'This instance has not been set up yet', 409);

	resetSsoThrottle();
	return ok(c, { token: await signAdminJwt(masterKeyManager, userId) }, 200);
});
