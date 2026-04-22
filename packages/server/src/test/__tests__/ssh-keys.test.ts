import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { loadAgentRoles } from '../../db/agent-roles';
import { seedBuiltins } from '../../db/seed';
import {
	generateCompanySSHKey,
	getCompanySSHKey,
	updateGitHubKeyId,
} from '../../services/ssh-keys';
import { createTestDbWithMigrations } from '../helpers/db';

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let companyId: string;

beforeAll(async () => {
	db = await createTestDbWithMigrations();
	masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db, generateMasterKey());
	await seedBuiltins(db, await loadAgentRoles());

	// Create a company
	const companyRes = await db.query<{ id: string }>(
		`INSERT INTO companies (name, slug)
		 VALUES ('SSH Test Co', 'ssh-test-co') RETURNING id`,
	);
	companyId = companyRes.rows[0].id;
});

afterAll(async () => {
	await db.close();
});

describe('SSH key management', () => {
	it('generates an Ed25519 SSH key pair', async () => {
		const result = await generateCompanySSHKey(db, companyId, masterKeyManager);

		expect(result.publicKey).toContain('ssh-ed25519');
		expect(result.fingerprint).toBeTruthy();
		expect(result.secretId).toBeTruthy();
	});

	it('stores the public key in company_ssh_keys', async () => {
		const row = await db.query<{ public_key: string; fingerprint: string }>(
			'SELECT public_key, fingerprint FROM company_ssh_keys WHERE company_id = $1',
			[companyId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].public_key).toContain('ssh-ed25519');
		expect(row.rows[0].fingerprint).toBeTruthy();
	});

	it('stores the private key encrypted in secrets', async () => {
		const row = await db.query<{ encrypted_value: string; category: string }>(
			"SELECT encrypted_value, category FROM secrets WHERE company_id = $1 AND name = 'ssh_private_key'",
			[companyId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].category).toBe('ssh_key');
		// Encrypted value should be base64 (not plaintext PEM)
		expect(row.rows[0].encrypted_value).not.toContain('-----BEGIN');
	});

	it('retrieves and decrypts the key pair', async () => {
		const result = await getCompanySSHKey(db, companyId, masterKeyManager);

		expect(result).not.toBeNull();
		expect(result!.publicKey).toContain('ssh-ed25519');
		expect(result!.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
		expect(result!.githubKeyId).toBeNull();
	});

	it('updates the GitHub key ID', async () => {
		await updateGitHubKeyId(db, companyId, 12345);

		const result = await getCompanySSHKey(db, companyId, masterKeyManager);
		expect(result!.githubKeyId).toBe(12345);
	});

	it('returns null for company without SSH key', async () => {
		const otherCompanyRes = await db.query<{ id: string }>(
			`INSERT INTO companies (name, slug)
			 VALUES ('No Key Co', 'no-key-co') RETURNING id`,
		);
		const result = await getCompanySSHKey(db, otherCompanyRes.rows[0].id, masterKeyManager);
		expect(result).toBeNull();
	});

	it('idempotent — regenerating overwrites existing key', async () => {
		const first = await getCompanySSHKey(db, companyId, masterKeyManager);
		await generateCompanySSHKey(db, companyId, masterKeyManager);
		const second = await getCompanySSHKey(db, companyId, masterKeyManager);

		expect(second!.publicKey).not.toBe(first!.publicKey);
		expect(second!.privateKey).not.toBe(first!.privateKey);
	});
});
