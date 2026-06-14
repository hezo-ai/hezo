import { verifyAuthSignature } from '@hezo/shared';
import { logger } from '../logger';
import { decrypt, deriveKey, encrypt } from './encryption';

const CANARY_PLAINTEXT = 'CANARY';
const CANARY_PURPOSE = 'master-key-canary';
const AUTH_PUBLIC_KEY_META = 'auth_public_key';

const log = logger.child('master-key');

export type MasterKeyState = 'unset' | 'locked' | 'unlocked';

interface DbClient {
	query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Holds the server's symmetric key material, derived from the **unlock key** —
 * a 32-byte key the client derives from the master-key mnemonic. The mnemonic
 * itself (and the Ed25519 auth private key derived alongside the unlock key)
 * never reaches the server; the unlock key transits only at setup and at
 * unlock-after-restart. The enrolled auth public key (stored in `system_meta`)
 * verifies challenge signatures for login/unlock.
 */
export class MasterKeyManager {
	private key: Buffer | null = null;
	private jwtKey: Buffer | null = null;
	private unlockKeyHex: string | null = null;
	private authPublicKeyHex: string | null = null;
	private state: MasterKeyState = 'unset';
	private unlockCallbacks: Array<() => void> = [];

	getState(): MasterKeyState {
		return this.state;
	}

	getKey(): Buffer | null {
		return this.key;
	}

	getUnlockKeyHex(): string | null {
		return this.unlockKeyHex;
	}

	/**
	 * Boot path. `publicKeyHex` is present only when booting from a CLI/env
	 * mnemonic — in that case a fresh database gets fully enrolled (equivalent
	 * to web setup), and an existing one gets its stored public key backfilled.
	 * An unlock key without a public key is the test-helper path: the canary is
	 * stored and the server unlocks, but the auth endpoints are unusable.
	 */
	async initialize(
		db: DbClient,
		unlockKeyHex?: string,
		publicKeyHex?: string,
	): Promise<MasterKeyState> {
		const canary = await this.loadCanary(db);

		if (canary) {
			if (unlockKeyHex && (await this.checkCanary(canary, unlockKeyHex))) {
				if (publicKeyHex) await this.ensureAuthPublicKey(db, publicKeyHex);
				await this.setUnlocked(unlockKeyHex);
			} else {
				this.state = 'locked';
			}
		} else if (unlockKeyHex && publicKeyHex) {
			await this.setup(db, unlockKeyHex, publicKeyHex);
		} else if (unlockKeyHex) {
			await this.storeCanary(db, unlockKeyHex);
			await this.setUnlocked(unlockKeyHex);
		} else {
			this.state = 'unset';
		}

		return this.state;
	}

	/**
	 * Explicit enrollment, only from 'unset': store the auth public key and the
	 * canary atomically, then unlock. Once a canary exists, unlock() is the only
	 * way in — there is no implicit re-enrollment.
	 */
	async setup(db: DbClient, unlockKeyHex: string, publicKeyHex: string): Promise<boolean> {
		if (this.state !== 'unset') return false;

		const derivedKey = await deriveKey(unlockKeyHex, CANARY_PURPOSE);
		const encryptedCanary = encrypt(CANARY_PLAINTEXT, derivedKey);
		await db.query('BEGIN');
		try {
			await db.query(
				`INSERT INTO system_meta (key, value) VALUES ($1, $2)
				 ON CONFLICT (key) DO UPDATE SET value = $2`,
				[AUTH_PUBLIC_KEY_META, publicKeyHex],
			);
			await db.query(
				`INSERT INTO system_meta (key, value) VALUES ('master_key_canary', $1)
				 ON CONFLICT (key) DO UPDATE SET value = $1`,
				[encryptedCanary],
			);
			await db.query('COMMIT');
		} catch (e) {
			await db.query('ROLLBACK');
			throw e;
		}

		this.authPublicKeyHex = publicKeyHex;
		await this.setUnlocked(unlockKeyHex);
		return true;
	}

	/**
	 * Canary check against an existing enrollment. Returns false when no canary
	 * exists yet (state 'unset') — enrollment goes through setup() explicitly.
	 */
	async unlock(db: DbClient, unlockKeyHex: string): Promise<boolean> {
		const canary = await this.loadCanary(db);
		if (canary && (await this.checkCanary(canary, unlockKeyHex))) {
			await this.setUnlocked(unlockKeyHex);
			return true;
		}
		return false;
	}

	onUnlock(callback: () => void): void {
		this.unlockCallbacks.push(callback);
		if (this.state === 'unlocked') callback();
	}

	async getJwtKey(): Promise<Buffer> {
		if (this.jwtKey) return this.jwtKey;
		if (!this.unlockKeyHex) throw new Error('Master key not available');
		this.jwtKey = await deriveKey(this.unlockKeyHex, 'jwt');
		return this.jwtKey;
	}

	/** The enrolled Ed25519 auth public key (hex), memoized after first read. */
	async getAuthPublicKeyHex(db: DbClient): Promise<string | null> {
		if (this.authPublicKeyHex) return this.authPublicKeyHex;
		const result = await db.query<{ value: string }>(
			'SELECT value FROM system_meta WHERE key = $1',
			[AUTH_PUBLIC_KEY_META],
		);
		this.authPublicKeyHex = result.rows[0]?.value ?? null;
		return this.authPublicKeyHex;
	}

	/** Verify an Ed25519 signature against the enrolled auth public key. */
	async verifySignature(db: DbClient, message: string, signatureHex: string): Promise<boolean> {
		const publicKeyHex = await this.getAuthPublicKeyHex(db);
		if (!publicKeyHex) return false;
		return verifyAuthSignature(publicKeyHex, message, signatureHex);
	}

	/**
	 * Boot-time backfill: ensure the stored public key matches the one derived
	 * from the boot mnemonic. The mnemonic is the root of trust, so a mismatch
	 * is overwritten (with a warning) rather than rejected.
	 */
	private async ensureAuthPublicKey(db: DbClient, publicKeyHex: string): Promise<void> {
		const stored = await this.getAuthPublicKeyHex(db);
		if (stored === publicKeyHex) return;
		if (stored) {
			log.warn('Stored auth public key differs from boot mnemonic; overwriting.');
		}
		await db.query(
			`INSERT INTO system_meta (key, value) VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = $2`,
			[AUTH_PUBLIC_KEY_META, publicKeyHex],
		);
		this.authPublicKeyHex = publicKeyHex;
	}

	private async setUnlocked(unlockKeyHex: string): Promise<void> {
		this.unlockKeyHex = unlockKeyHex;
		this.key = await deriveKey(unlockKeyHex, 'encryption');
		const wasLocked = this.state !== 'unlocked';
		this.state = 'unlocked';
		if (wasLocked) {
			for (const cb of this.unlockCallbacks) cb();
		}
	}

	private async loadCanary(db: DbClient): Promise<string | null> {
		const result = await db.query<{ value: string }>(
			"SELECT value FROM system_meta WHERE key = 'master_key_canary'",
		);
		return result.rows[0]?.value ?? null;
	}

	private async storeCanary(db: DbClient, unlockKeyHex: string): Promise<void> {
		const derivedKey = await deriveKey(unlockKeyHex, CANARY_PURPOSE);
		const encrypted = encrypt(CANARY_PLAINTEXT, derivedKey);
		await db.query(
			`INSERT INTO system_meta (key, value) VALUES ('master_key_canary', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
			[encrypted],
		);
	}

	private async checkCanary(encryptedCanary: string, unlockKeyHex: string): Promise<boolean> {
		try {
			const derivedKey = await deriveKey(unlockKeyHex, CANARY_PURPOSE);
			return decrypt(encryptedCanary, derivedKey) === CANARY_PLAINTEXT;
		} catch {
			return false;
		}
	}
}

export { generateUnlockKey } from './encryption';
