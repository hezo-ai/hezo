import { generateKeyPairSync } from 'node:crypto';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { seedBuiltins } from '../../db/seed';
import { signBoardJwt } from '../../middleware/auth';
import { buildApp } from '../../startup';
import { createTestDbWithMigrations } from './db';

// Generate a test Ed25519 keypair for Connect state verification
const testKeyPair = generateKeyPairSync('ed25519', {
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const TEST_CONNECT_PRIVATE_KEY = testKeyPair.privateKey;
export const TEST_CONNECT_PUBLIC_KEY = testKeyPair.publicKey;

export async function createTestApp() {
	const db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateMasterKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	await seedBuiltins(db);
	const app = buildApp(db, masterKeyManager, {
		dataDir: '',
		connectUrl: 'http://localhost:4100',
		connectPublicKey: TEST_CONNECT_PUBLIC_KEY,
	});
	const token = await signBoardJwt(masterKeyManager, 'test-user');

	return { app, db, token, masterKeyHex, masterKeyManager };
}

export function authHeader(token: string) {
	return { Authorization: `Bearer ${token}` };
}
