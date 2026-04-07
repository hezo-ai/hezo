import { decrypt, deriveKey, encrypt } from './encryption';

const CANARY_PLAINTEXT = 'CANARY';
const CANARY_PURPOSE = 'master-key-canary';

export type MasterKeyState = 'unset' | 'locked' | 'unlocked';

interface DbClient {
	query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export class MasterKeyManager {
	private key: Buffer | null = null;
	private jwtKey: Buffer | null = null;
	private masterKeyHex: string | null = null;
	private state: MasterKeyState = 'unset';
	private unlockCallbacks: Array<() => void> = [];

	getState(): MasterKeyState {
		return this.state;
	}

	getKey(): Buffer | null {
		return this.key;
	}

	getMasterKeyHex(): string | null {
		return this.masterKeyHex;
	}

	async initialize(db: DbClient, masterKeyHex?: string): Promise<MasterKeyState> {
		const canary = await this.loadCanary(db);

		if (canary) {
			if (masterKeyHex && (await this.checkCanary(canary, masterKeyHex))) {
				await this.setUnlocked(masterKeyHex);
			} else {
				this.state = 'locked';
			}
		} else {
			if (masterKeyHex) {
				await this.storeCanary(db, masterKeyHex);
				await this.setUnlocked(masterKeyHex);
			} else {
				this.state = 'unset';
			}
		}

		return this.state;
	}

	async unlock(db: DbClient, masterKeyHex: string): Promise<boolean> {
		if (this.state === 'unset') {
			await this.storeCanary(db, masterKeyHex);
			await this.setUnlocked(masterKeyHex);
			return true;
		}

		const canary = await this.loadCanary(db);
		if (canary && (await this.checkCanary(canary, masterKeyHex))) {
			await this.setUnlocked(masterKeyHex);
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
		if (!this.masterKeyHex) throw new Error('Master key not available');
		this.jwtKey = await deriveKey(this.masterKeyHex, 'jwt');
		return this.jwtKey;
	}

	private async setUnlocked(masterKeyHex: string): Promise<void> {
		this.masterKeyHex = masterKeyHex;
		this.key = await deriveKey(masterKeyHex, 'encryption');
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

	private async storeCanary(db: DbClient, masterKeyHex: string): Promise<void> {
		const derivedKey = await deriveKey(masterKeyHex, CANARY_PURPOSE);
		const encrypted = encrypt(CANARY_PLAINTEXT, derivedKey);
		await db.query(
			`INSERT INTO system_meta (key, value) VALUES ('master_key_canary', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
			[encrypted],
		);
	}

	private async checkCanary(encryptedCanary: string, masterKeyHex: string): Promise<boolean> {
		try {
			const derivedKey = await deriveKey(masterKeyHex, CANARY_PURPOSE);
			return decrypt(encryptedCanary, derivedKey) === CANARY_PLAINTEXT;
		} catch {
			return false;
		}
	}
}

export { generateMasterKey } from './encryption';
