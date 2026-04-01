import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signOAuthState, verifyConnectState, verifyOAuthState } from '../../crypto/state';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { createTestDbWithMigrations } from '../helpers/db';

describe('verifyConnectState (Ed25519)', () => {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});

	function signForTest(payload: Record<string, unknown>): string {
		const { sign } = require('node:crypto');
		const json = JSON.stringify(payload);
		const encoded = Buffer.from(json).toString('base64url');
		const signature = sign(null, Buffer.from(encoded), privateKey).toString('base64url');
		return `${encoded}.${signature}`;
	}

	it('verifies a valid signed state', () => {
		const payload = {
			callback_url: 'http://localhost:3100/oauth/callback',
			platform: 'github',
			nonce: 'test-nonce',
			timestamp: '2026-04-01T00:00:00Z',
		};
		const signed = signForTest(payload);
		const result = verifyConnectState(signed, publicKey);
		expect(result).toEqual(payload);
	});

	it('returns null for tampered payload', () => {
		const payload = { callback_url: 'http://localhost:3100', platform: 'github', nonce: 'n', timestamp: 't' };
		const signed = signForTest(payload);
		const [, sig] = signed.split('.');
		const tampered = Buffer.from(JSON.stringify({ ...payload, platform: 'evil' })).toString('base64url') + '.' + sig;
		expect(verifyConnectState(tampered, publicKey)).toBeNull();
	});

	it('returns null with different public key', () => {
		const other = generateKeyPairSync('ed25519', {
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' },
		});
		const signed = signForTest({ callback_url: 'x', platform: 'github', nonce: 'n', timestamp: 't' });
		expect(verifyConnectState(signed, other.publicKey)).toBeNull();
	});

	it('returns null for no dot separator', () => {
		expect(verifyConnectState('nodothere', publicKey)).toBeNull();
	});

	it('returns null for empty string', () => {
		expect(verifyConnectState('', publicKey)).toBeNull();
	});
});

describe('signOAuthState + verifyOAuthState', () => {
	it('roundtrips company_id', async () => {
		const db = await createTestDbWithMigrations();
		const mkm = new MasterKeyManager();
		await mkm.initialize(db, generateMasterKey());

		const signed = await signOAuthState({ company_id: 'abc-123' }, mkm);
		const result = await verifyOAuthState(signed, mkm);
		expect(result).toEqual({ company_id: 'abc-123' });
		await db.close();
	});

	it('returns null for tampered state', async () => {
		const db = await createTestDbWithMigrations();
		const mkm = new MasterKeyManager();
		await mkm.initialize(db, generateMasterKey());

		const signed = await signOAuthState({ company_id: 'abc-123' }, mkm);
		const tampered = signed.slice(0, -4) + 'xxxx';
		const result = await verifyOAuthState(tampered, mkm);
		expect(result).toBeNull();
		await db.close();
	});

	it('returns null with different master key', async () => {
		const db1 = await createTestDbWithMigrations();
		const mkm1 = new MasterKeyManager();
		await mkm1.initialize(db1, generateMasterKey());

		const db2 = await createTestDbWithMigrations();
		const mkm2 = new MasterKeyManager();
		await mkm2.initialize(db2, generateMasterKey());

		const signed = await signOAuthState({ company_id: 'abc' }, mkm1);
		const result = await verifyOAuthState(signed, mkm2);
		expect(result).toBeNull();

		await db1.close();
		await db2.close();
	});

	it('returns null for no dot separator', async () => {
		const db = await createTestDbWithMigrations();
		const mkm = new MasterKeyManager();
		await mkm.initialize(db, generateMasterKey());

		const result = await verifyOAuthState('nodot', mkm);
		expect(result).toBeNull();
		await db.close();
	});
});
