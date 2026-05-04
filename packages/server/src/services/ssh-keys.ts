import { createHash, generateKeyPairSync } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { decrypt, encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';

export interface SSHKeyResult {
	publicKey: string;
	fingerprint: string;
	secretId: string;
}

export async function generateCompanySSHKey(
	db: PGlite,
	companyId: string,
	masterKeyManager: MasterKeyManager,
): Promise<SSHKeyResult> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	// Convert PEM public key to SSH format for GitHub
	const sshPublicKey = pemToSSHPublicKey(publicKey);
	const fingerprint = createHash('sha256').update(Buffer.from(publicKey)).digest('hex');
	const encryptedPrivateKey = encrypt(privateKey, encryptionKey);

	// Store private key in secrets
	const secretResult = await db.query<{ id: string }>(
		`INSERT INTO secrets (company_id, name, encrypted_value, category)
		 VALUES ($1, 'ssh_private_key', $2, 'ssh_key')
		 ON CONFLICT (company_id, project_id, name) WHERE project_id IS NULL
		 DO UPDATE SET encrypted_value = $2, updated_at = now()
		 RETURNING id`,
		[companyId, encryptedPrivateKey],
	);
	const secretId = secretResult.rows[0].id;

	// Store public key in company_ssh_keys
	await db.query(
		`INSERT INTO company_ssh_keys (company_id, public_key, fingerprint, private_key_secret_id)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (company_id) DO UPDATE SET
		   public_key = $2, fingerprint = $3, private_key_secret_id = $4`,
		[companyId, sshPublicKey, fingerprint, secretId],
	);

	return { publicKey: sshPublicKey, fingerprint, secretId };
}

export async function getCompanySSHKey(
	db: PGlite,
	companyId: string,
	masterKeyManager: MasterKeyManager,
): Promise<{ publicKey: string; privateKey: string } | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const result = await db.query<{
		public_key: string;
		encrypted_value: string;
	}>(
		`SELECT k.public_key, s.encrypted_value
		 FROM company_ssh_keys k
		 JOIN secrets s ON s.id = k.private_key_secret_id
		 WHERE k.company_id = $1`,
		[companyId],
	);

	if (result.rows.length === 0) return null;

	const row = result.rows[0];
	return {
		publicKey: row.public_key,
		privateKey: decrypt(row.encrypted_value, encryptionKey),
	};
}

function pemToSSHPublicKey(pem: string): string {
	// Extract the base64 content from PEM, decode, and format as SSH key
	const lines = pem.split('\n').filter((l) => !l.startsWith('-----') && l.trim().length > 0);
	const derBytes = Buffer.from(lines.join(''), 'base64');

	// For Ed25519, the DER-encoded SPKI has a fixed 12-byte prefix before the 32-byte key
	const ed25519Key = derBytes.subarray(derBytes.length - 32);

	// SSH format: string "ssh-ed25519" + string <32-byte key>
	const typeStr = 'ssh-ed25519';
	const typeLen = Buffer.alloc(4);
	typeLen.writeUInt32BE(typeStr.length);
	const typeBytes = Buffer.from(typeStr);
	const keyLen = Buffer.alloc(4);
	keyLen.writeUInt32BE(ed25519Key.length);
	const sshKey = Buffer.concat([typeLen, typeBytes, keyLen, ed25519Key]);

	return `ssh-ed25519 ${sshKey.toString('base64')} hezo`;
}
