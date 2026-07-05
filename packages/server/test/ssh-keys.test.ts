import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { loadAgentRoles } from '../src/db/agent-roles';
import type { Db } from '../src/db/database';
import { seedBuiltins } from '../src/db/seed';
import { generateTeamSSHKey, getTeamSSHKey } from '../src/services/ssh-keys';
import { createTestDbWithMigrations } from './helpers/db';

let db: Db;
let masterKeyManager: MasterKeyManager;
let teamId: string;

beforeAll(async () => {
	db = await createTestDbWithMigrations();
	masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db, generateUnlockKey());
	await seedBuiltins(db, await loadAgentRoles());

	// Create a team
	const teamRes = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug)
		 VALUES ('SSH Test Co', 'ssh-test-co') RETURNING id`,
	);
	teamId = teamRes.rows[0].id;
});

afterAll(async () => {
	await db.close();
});

describe('SSH key management', () => {
	it('generates an Ed25519 SSH key pair', async () => {
		const result = await generateTeamSSHKey(db, teamId, masterKeyManager);

		expect(result.publicKey).toContain('ssh-ed25519');
		expect(result.fingerprint).toBeTruthy();
	});

	it('stores the public key and encrypted private key on team_ssh_keys', async () => {
		const row = await db.query<{
			public_key: string;
			fingerprint: string;
			private_key_encrypted: string;
		}>(
			'SELECT public_key, fingerprint, private_key_encrypted FROM team_ssh_keys WHERE team_id = $1',
			[teamId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].public_key).toContain('ssh-ed25519');
		expect(row.rows[0].fingerprint).toBeTruthy();
		// Private key is encrypted at rest (not plaintext PEM) and stays per-team,
		// out of the global secrets table.
		expect(row.rows[0].private_key_encrypted).toBeTruthy();
		expect(row.rows[0].private_key_encrypted).not.toContain('-----BEGIN');
	});

	it('retrieves and decrypts the key pair', async () => {
		const result = await getTeamSSHKey(db, teamId, masterKeyManager);

		expect(result).not.toBeNull();
		expect(result!.publicKey).toContain('ssh-ed25519');
		expect(result!.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
	});

	it('returns null for team without SSH key', async () => {
		const otherTeamRes = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug)
			 VALUES ('No Key Co', 'no-key-co') RETURNING id`,
		);
		const result = await getTeamSSHKey(db, otherTeamRes.rows[0].id, masterKeyManager);
		expect(result).toBeNull();
	});

	it('idempotent — regenerating overwrites existing key', async () => {
		const first = await getTeamSSHKey(db, teamId, masterKeyManager);
		await generateTeamSSHKey(db, teamId, masterKeyManager);
		const second = await getTeamSSHKey(db, teamId, masterKeyManager);

		expect(second!.publicKey).not.toBe(first!.publicKey);
		expect(second!.privateKey).not.toBe(first!.privateKey);
	});
});
