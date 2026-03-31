import type { PGlite } from '@electric-sql/pglite';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { seedBuiltins } from '../../db/seed';
import { signBoardJwt } from '../../middleware/auth';
import { buildApp } from '../../startup';
import { createTestDbWithMigrations } from './db';

export async function createTestApp() {
	const db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateMasterKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	await seedBuiltins(db);
	const app = buildApp(db, masterKeyManager);
	const token = await signBoardJwt(masterKeyManager, 'test-user');

	return { app, db, token, masterKeyHex, masterKeyManager };
}

export function authHeader(token: string) {
	return { Authorization: `Bearer ${token}` };
}
