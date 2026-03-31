import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { decrypt, deriveKey, encrypt, generateMasterKey } from '../../crypto/encryption';
import { MasterKeyManager } from '../../crypto/master-key';

describe('encryption', () => {
	it('encrypts and decrypts to original plaintext', async () => {
		const key = await deriveKey('test-key', 'test');
		const plaintext = 'hello world';
		const encrypted = encrypt(plaintext, key);
		expect(decrypt(encrypted, key)).toBe(plaintext);
	});

	it('fails to decrypt with wrong key', async () => {
		const key1 = await deriveKey('key-one', 'test');
		const key2 = await deriveKey('key-two', 'test');
		const encrypted = encrypt('secret', key1);
		expect(() => decrypt(encrypted, key2)).toThrow();
	});

	it('generates a 64-char hex master key', () => {
		const key = generateMasterKey();
		expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	it('derives consistent keys for same inputs', async () => {
		const a = await deriveKey('master', 'purpose');
		const b = await deriveKey('master', 'purpose');
		expect(a.equals(b)).toBe(true);
	});

	it('derives different keys for different purposes', async () => {
		const a = await deriveKey('master', 'purpose-a');
		const b = await deriveKey('master', 'purpose-b');
		expect(a.equals(b)).toBe(false);
	});
});

describe('MasterKeyManager', () => {
	let db: PGlite;

	beforeEach(async () => {
		db = new PGlite();
		await db.query(
			'CREATE TABLE IF NOT EXISTS system_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
		);
	});

	it("returns 'unset' on first run with no key", async () => {
		const mgr = new MasterKeyManager();
		const state = await mgr.initialize(db);
		expect(state).toBe('unset');
		expect(mgr.getKey()).toBeNull();
	});

	it("returns 'unlocked' on first run with key provided", async () => {
		const mgr = new MasterKeyManager();
		const key = generateMasterKey();
		const state = await mgr.initialize(db, key);
		expect(state).toBe('unlocked');
		expect(mgr.getKey()).not.toBeNull();
	});

	it("returns 'unlocked' on subsequent run with correct key", async () => {
		const key = generateMasterKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, key);

		const mgr2 = new MasterKeyManager();
		const state = await mgr2.initialize(db, key);
		expect(state).toBe('unlocked');
	});

	it("returns 'locked' on subsequent run with wrong key", async () => {
		const correctKey = generateMasterKey();
		const wrongKey = generateMasterKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, correctKey);

		const mgr2 = new MasterKeyManager();
		const state = await mgr2.initialize(db, wrongKey);
		expect(state).toBe('locked');
		expect(mgr2.getKey()).toBeNull();
	});

	it("returns 'locked' on subsequent run with no key", async () => {
		const key = generateMasterKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, key);

		const mgr2 = new MasterKeyManager();
		const state = await mgr2.initialize(db);
		expect(state).toBe('locked');
	});

	it("unlocks from 'locked' with correct key", async () => {
		const key = generateMasterKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, key);

		const mgr2 = new MasterKeyManager();
		await mgr2.initialize(db);
		expect(mgr2.getState()).toBe('locked');

		const result = await mgr2.unlock(db, key);
		expect(result).toBe(true);
		expect(mgr2.getState()).toBe('unlocked');
		expect(mgr2.getKey()).not.toBeNull();
	});

	it("stays 'locked' when unlocking with wrong key", async () => {
		const key = generateMasterKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, key);

		const mgr2 = new MasterKeyManager();
		await mgr2.initialize(db);

		const result = await mgr2.unlock(db, generateMasterKey());
		expect(result).toBe(false);
		expect(mgr2.getState()).toBe('locked');
	});

	it("unlocks from 'unset' by storing canary", async () => {
		const mgr = new MasterKeyManager();
		await mgr.initialize(db);
		expect(mgr.getState()).toBe('unset');

		const key = generateMasterKey();
		const result = await mgr.unlock(db, key);
		expect(result).toBe(true);
		expect(mgr.getState()).toBe('unlocked');

		// Verify canary was stored by initializing a new manager
		const mgr2 = new MasterKeyManager();
		const state = await mgr2.initialize(db, key);
		expect(state).toBe('unlocked');
	});
});
