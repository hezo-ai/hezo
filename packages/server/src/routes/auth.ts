import {
	buildLoginMessage,
	buildSetupMessage,
	buildUnlockMessage,
	DEFAULT_TEAM_ID,
	MemberType,
	verifyAuthSignature,
} from '@hezo/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
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
import { signAdminJwt } from '../middleware/auth';

const log = logger.child('routes');

const KEY_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;

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

	return issueAdminSession(c);
});

// Step 1 of login/unlock: a single-use nonce for the client to sign.
authRoutes.post('/auth/challenge', (c) => {
	if (c.get('masterKeyManager').getState() === 'unset') {
		return err(c, 'SETUP_REQUIRED', 'No master key set. Run setup first.', 409);
	}
	const { challengeId, nonce, expiresInSeconds } = c.get('authChallenges').issue();
	return ok(c, { challenge_id: challengeId, nonce, expires_in: expiresInSeconds });
});

// Step 2: verify the Ed25519 signature over the stored nonce and issue a JWT.
// The client signs buildUnlockMessage(nonce, unlock_key) when it includes the
// unlock key (server locked), buildLoginMessage(nonce) otherwise. The nonce is
// never echoed back — the message is reconstructed from the stored copy, so
// the signature is the sole authenticator.
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

	return issueAdminSession(c);
});

/** Shared tail of setup/verify: capture base URL, ensure superuser, mint JWT. */
async function issueAdminSession(c: Context<Env>) {
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

	const existing = await db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true LIMIT 1',
	);
	let userId: string;
	if (existing.rows.length > 0) {
		userId = existing.rows[0].id;
	} else {
		const inserted = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Admin', true) RETURNING id",
		);
		userId = inserted.rows[0].id;
		await addUserToDefaultTeam(db, userId);
	}

	const token = await signAdminJwt(masterKeyManager, userId);
	return ok(c, { token }, 200);
}

async function addUserToDefaultTeam(
	db: import('@electric-sql/pglite').PGlite,
	userId: string,
): Promise<void> {
	const existing = await db.query(
		`SELECT m.id FROM members m
		 JOIN member_users mu ON mu.id = m.id
		 WHERE mu.user_id = $1 AND m.team_id = $2`,
		[userId, DEFAULT_TEAM_ID],
	);
	if (existing.rows.length > 0) return;

	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, $2, (SELECT display_name FROM users WHERE id = $3))
		 RETURNING id`,
		[DEFAULT_TEAM_ID, MemberType.User, userId],
	);
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
		member.rows[0].id,
		userId,
	]);
}
