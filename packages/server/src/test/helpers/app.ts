import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { loadAgentRoles } from '../../db/agent-roles';
import { seedBuiltins } from '../../db/seed';
import { signBoardJwt } from '../../middleware/auth';
import type { DockerClient } from '../../services/docker';
import { buildApp } from '../../startup';
import { createTestDbWithMigrations } from './db';

// Generate a test Ed25519 keypair for Connect state verification
const testKeyPair = generateKeyPairSync('ed25519', {
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const TEST_CONNECT_PRIVATE_KEY = testKeyPair.privateKey;
export const TEST_CONNECT_PUBLIC_KEY = testKeyPair.publicKey;

export function createStubDocker(): DockerClient {
	return {
		ping: async () => true,
		pullImage: async () => {},
		createContainer: async () => ({ Id: 'stub-container', Warnings: [] }),
		startContainer: async () => {},
		stopContainer: async () => {},
		removeContainer: async () => {},
		inspectContainer: async () => ({
			Id: 'stub-container',
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'stub' },
		}),
		containerLogs: async () => new ReadableStream(),
		execCreate: async () => {
			throw new Error('execCreate not mocked — pass a mock docker via RunnerDeps');
		},
		execStart: async () => ({ stdout: '', stderr: '' }),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
	} as unknown as DockerClient;
}

export async function createTestApp() {
	const db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateMasterKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	const roleDocs = await loadAgentRoles();
	await seedBuiltins(db, roleDocs);
	const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
	const app = buildApp(
		db,
		masterKeyManager,
		{
			dataDir,
			connectUrl: 'http://localhost:4100',
			connectPublicKey: TEST_CONNECT_PUBLIC_KEY,
		},
		createStubDocker(),
	);
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Test Admin', true) RETURNING id",
	);
	const token = await signBoardJwt(masterKeyManager, userResult.rows[0].id);

	return { app, db, token, masterKeyHex, masterKeyManager, dataDir };
}

export function authHeader(token: string) {
	return { Authorization: `Bearer ${token}` };
}
