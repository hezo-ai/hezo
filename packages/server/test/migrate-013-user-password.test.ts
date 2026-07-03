import {
	buildPasswordLoginMessage,
	derivePasswordKeyPair,
	signAuthMessage,
	verifyAuthSignature,
} from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

// Code migration — keyed by its registry name (no .sql extension).
const TARGET = '013_user_password';

describe('013_user_password migration', () => {
	let h: DataPreservationHarness;
	let adminId: string;
	let plainUserId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 013

		const admin = await h.db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Admin', true) RETURNING id`,
		);
		adminId = admin.rows[0].id;
		const plain = await h.db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Board User', false) RETURNING id`,
		);
		plainUserId = plain.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the verifier columns', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'users' AND column_name IN ('password_salt', 'password_public_key')`,
		);
		expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
			'password_public_key',
			'password_salt',
		]);
	});

	it('preserves the pre-existing admin row', async () => {
		const kept = await h.db.query<{ display_name: string }>(
			`SELECT display_name FROM users WHERE id = $1`,
			[adminId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0].display_name).toBe('Admin');
	});

	it('backfills the admin with the default password "password"', async () => {
		const row = await h.db.query<{ password_salt: string; password_public_key: string }>(
			`SELECT password_salt, password_public_key FROM users WHERE id = $1`,
			[adminId],
		);
		const { password_salt, password_public_key } = row.rows[0];
		expect(password_salt).toMatch(/^[0-9a-f]{32}$/);
		expect(password_public_key).toMatch(/^[0-9a-f]{64}$/);

		// The stored verifier must validate a login signature produced from the
		// default password + backfilled salt — exactly what the browser would send.
		const { publicKeyHex, privateKey } = await derivePasswordKeyPair('password', password_salt);
		expect(publicKeyHex).toBe(password_public_key);
		const sig = signAuthMessage(privateKey, buildPasswordLoginMessage('cafef00d'));
		expect(
			verifyAuthSignature(password_public_key, buildPasswordLoginMessage('cafef00d'), sig),
		).toBe(true);

		// A wrong password would NOT validate against the stored verifier.
		const wrong = await derivePasswordKeyPair('hunter2', password_salt);
		const wrongSig = signAuthMessage(wrong.privateKey, buildPasswordLoginMessage('cafef00d'));
		expect(
			verifyAuthSignature(password_public_key, buildPasswordLoginMessage('cafef00d'), wrongSig),
		).toBe(false);
	});

	it('leaves a non-superuser without a verifier', async () => {
		const row = await h.db.query<{ password_public_key: string | null }>(
			`SELECT password_public_key FROM users WHERE id = $1`,
			[plainUserId],
		);
		expect(row.rows[0].password_public_key).toBeNull();
	});
});
