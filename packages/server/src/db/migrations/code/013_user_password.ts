import type { PGlite } from '@electric-sql/pglite';
import { derivePasswordKeyPair, generatePasswordSalt } from '@hezo/shared';
import type { CodeMigration } from '../../migrate';

/**
 * Adds password authentication to the single admin user.
 *
 * A password is never stored — only a *verifier*: a per-admin salt plus the
 * Ed25519 public key derived from `scrypt(password, salt)` (see
 * `derivePasswordKeyPair` in `@hezo/shared`). Login is challenge-response, so the
 * password never leaves the browser. This is a code migration (not plain SQL)
 * because the backfill has to run the same scrypt+Ed25519 derivation the browser
 * uses, which SQL can't express.
 *
 * Existing installations: every superuser without a verifier is backfilled with
 * the default password `"password"` so the operator can sign in immediately after
 * upgrading (and is prompted to change it). A brand-new instance has no users row
 * at migration time — the admin is created lazily on first `/auth/setup` and
 * enrolls its own verifier through onboarding — so the backfill is a no-op there.
 */
const DEFAULT_PASSWORD = 'password';

export const migration013UserPassword: CodeMigration = {
	// Explicit, stable — a minifier rewriting run.toString() must not shift it.
	checksum: '013_user_password_v1',
	run: async (db: PGlite) => {
		await db.exec(`
			ALTER TABLE users ADD COLUMN password_salt TEXT;
			ALTER TABLE users ADD COLUMN password_public_key TEXT;
		`);

		const existingAdmins = await db.query<{ id: string }>(
			`SELECT id FROM users WHERE is_superuser = true AND password_public_key IS NULL`,
		);
		for (const { id } of existingAdmins.rows) {
			const salt = generatePasswordSalt();
			const { publicKeyHex } = await derivePasswordKeyPair(DEFAULT_PASSWORD, salt);
			await db.query(
				`UPDATE users SET password_salt = $1, password_public_key = $2, updated_at = now() WHERE id = $3`,
				[salt, publicKeyHex, id],
			);
		}
	},
};
