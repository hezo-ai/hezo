import { verifyAuthSignature } from '@hezo/shared';
import type { Db } from '../db/database';

/**
 * Admin password auth — verifier storage + signature checks.
 *
 * The password is never sent to the server and never stored. What the browser
 * derives from `scrypt(password, salt)` is an Ed25519 keypair; the server keeps
 * only the **verifier** (`password_salt` + `password_public_key`) and proves the
 * caller by verifying a signature over a one-time challenge nonce. The crypto
 * primitives live in `@hezo/shared` so browser enrollment and the server-side
 * backfill derive an identical verifier.
 */

export interface PasswordVerifier {
	userId: string;
	salt: string;
	publicKeyHex: string;
}

/** The superuser's password verifier, or `null` if none is enrolled yet. */
export async function getAdminPasswordVerifier(db: Db): Promise<PasswordVerifier | null> {
	const result = await db.query<{
		id: string;
		password_salt: string | null;
		password_public_key: string | null;
	}>(
		`SELECT id, password_salt, password_public_key
		 FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1`,
	);
	const row = result.rows[0];
	if (!row || !row.password_salt || !row.password_public_key) return null;
	return { userId: row.id, salt: row.password_salt, publicKeyHex: row.password_public_key };
}

/** True once the admin has enrolled a password verifier. */
export async function adminPasswordIsSet(db: Db): Promise<boolean> {
	const result = await db.query<{ count: number }>(
		`SELECT COUNT(*)::int AS count FROM users
		 WHERE is_superuser = true AND password_public_key IS NOT NULL`,
	);
	return (result.rows[0]?.count ?? 0) > 0;
}

/** Store (or replace) the admin's password verifier. */
export async function setAdminPasswordVerifier(
	db: Db,
	userId: string,
	verifier: { salt: string; publicKeyHex: string },
): Promise<void> {
	await db.query(
		`UPDATE users SET password_salt = $1, password_public_key = $2, updated_at = now()
		 WHERE id = $3`,
		[verifier.salt, verifier.publicKeyHex, userId],
	);
}

/**
 * Verify an Ed25519 signature over `message` against the admin's stored password
 * public key. Returns false (never throws) when no verifier is enrolled or the
 * signature doesn't check out.
 */
export async function verifyPasswordSignature(
	db: Db,
	message: string,
	signatureHex: string,
): Promise<boolean> {
	const verifier = await getAdminPasswordVerifier(db);
	if (!verifier) return false;
	return verifyAuthSignature(verifier.publicKeyHex, message, signatureHex);
}
