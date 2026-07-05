import { beforeEach, describe, expect, it } from 'vitest';
import { decrypt, deriveKey, encrypt, generateUnlockKey } from '../src/crypto/encryption';
import { MasterKeyManager } from '../src/crypto/master-key';
import { createMemoryDb } from '../src/db/client';
import type { PgliteDb } from '../src/db/drivers/pglite';

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

	it('generates a 64-char hex unlock key', () => {
		const key = generateUnlockKey();
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
	let db: PgliteDb;

	beforeEach(async () => {
		db = await createMemoryDb();
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
		const key = generateUnlockKey();
		const state = await mgr.initialize(db, key);
		expect(state).toBe('unlocked');
		expect(mgr.getKey()).not.toBeNull();
	});

	it("returns 'unlocked' on subsequent run with correct key", async () => {
		const key = generateUnlockKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, key);

		const mgr2 = new MasterKeyManager();
		const state = await mgr2.initialize(db, key);
		expect(state).toBe('unlocked');
	});

	it("returns 'locked' on subsequent run with wrong key", async () => {
		const correctKey = generateUnlockKey();
		const wrongKey = generateUnlockKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, correctKey);

		const mgr2 = new MasterKeyManager();
		const state = await mgr2.initialize(db, wrongKey);
		expect(state).toBe('locked');
		expect(mgr2.getKey()).toBeNull();
	});

	it("returns 'locked' on subsequent run with no key", async () => {
		const key = generateUnlockKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, key);

		const mgr2 = new MasterKeyManager();
		const state = await mgr2.initialize(db);
		expect(state).toBe('locked');
	});

	it("unlocks from 'locked' with correct key", async () => {
		const key = generateUnlockKey();
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
		const key = generateUnlockKey();
		const mgr1 = new MasterKeyManager();
		await mgr1.initialize(db, key);

		const mgr2 = new MasterKeyManager();
		await mgr2.initialize(db);

		const result = await mgr2.unlock(db, generateUnlockKey());
		expect(result).toBe(false);
		expect(mgr2.getState()).toBe('locked');
	});

	it("refuses unlock() from 'unset' — enrollment is explicit via setup()", async () => {
		const mgr = new MasterKeyManager();
		await mgr.initialize(db);
		expect(mgr.getState()).toBe('unset');

		const result = await mgr.unlock(db, generateUnlockKey());
		expect(result).toBe(false);
		expect(mgr.getState()).toBe('unset');
	});

	it("setup() from 'unset' stores public key + canary atomically and unlocks", async () => {
		const mgr = new MasterKeyManager();
		await mgr.initialize(db);
		const key = generateUnlockKey();
		const publicKey = 'ab'.repeat(32);

		const result = await mgr.setup(db, key, publicKey);
		expect(result).toBe(true);
		expect(mgr.getState()).toBe('unlocked');
		expect(await mgr.getAuthPublicKeyHex(db)).toBe(publicKey);

		// A fresh manager unlocks against the stored canary and reads the key.
		const mgr2 = new MasterKeyManager();
		expect(await mgr2.initialize(db, key)).toBe('unlocked');
		expect(await mgr2.getAuthPublicKeyHex(db)).toBe(publicKey);
	});

	it('setup() refuses to run twice', async () => {
		const mgr = new MasterKeyManager();
		await mgr.initialize(db);
		const key = generateUnlockKey();
		expect(await mgr.setup(db, key, 'ab'.repeat(32))).toBe(true);
		expect(await mgr.setup(db, generateUnlockKey(), 'cd'.repeat(32))).toBe(false);
		expect(await mgr.getAuthPublicKeyHex(db)).toBe('ab'.repeat(32));
	});

	it('initialize() with both params enrolls a fresh database (CLI/env boot)', async () => {
		const mgr = new MasterKeyManager();
		const key = generateUnlockKey();
		const state = await mgr.initialize(db, key, 'ab'.repeat(32));
		expect(state).toBe('unlocked');
		expect(await mgr.getAuthPublicKeyHex(db)).toBe('ab'.repeat(32));
	});

	it('initialize() backfills a missing public key on an already-enrolled database', async () => {
		const key = generateUnlockKey();
		const mgr1 = new MasterKeyManager();
		// Canary without a public key (the bare test-helper path).
		await mgr1.initialize(db, key);

		const mgr2 = new MasterKeyManager();
		await mgr2.initialize(db, key, 'ef'.repeat(32));
		expect(mgr2.getState()).toBe('unlocked');
		expect(await mgr2.getAuthPublicKeyHex(db)).toBe('ef'.repeat(32));
	});

	it('getAuthPublicKeyHex returns null when nothing is enrolled', async () => {
		const mgr = new MasterKeyManager();
		await mgr.initialize(db);
		expect(await mgr.getAuthPublicKeyHex(db)).toBeNull();
	});

	it('fires onUnlock callback when transitioning to unlocked', async () => {
		const key = generateUnlockKey();
		const mgr = new MasterKeyManager();
		await mgr.initialize(db);
		expect(mgr.getState()).toBe('unset');

		let callCount = 0;
		mgr.onUnlock(() => callCount++);

		await mgr.setup(db, key, 'ab'.repeat(32));
		expect(callCount).toBe(1);

		// Subsequent unlock with same key should NOT fire again
		await mgr.unlock(db, key);
		expect(callCount).toBe(1);
	});

	it('fires onUnlock immediately if already unlocked when registered', async () => {
		const key = generateUnlockKey();
		const mgr = new MasterKeyManager();
		await mgr.initialize(db, key);
		expect(mgr.getState()).toBe('unlocked');

		let fired = false;
		mgr.onUnlock(() => {
			fired = true;
		});
		expect(fired).toBe(true);
	});

	it('fires onUnlock callback on initialize with key', async () => {
		const key = generateUnlockKey();
		const mgr = new MasterKeyManager();

		let callCount = 0;
		mgr.onUnlock(() => callCount++);

		await mgr.initialize(db, key);
		expect(callCount).toBe(1);
	});
});
