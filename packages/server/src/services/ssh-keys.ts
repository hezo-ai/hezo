import { createHash, generateKeyPairSync } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { decrypt, encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';

export interface SSHKeyResult {
	publicKey: string;
	fingerprint: string;
}

export async function generateTeamSSHKey(
	db: PGlite,
	teamId: string,
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

	// The per-team signing key's PEM is encrypted directly on team_ssh_keys, not
	// in the global `secrets` table.
	await db.query(
		`INSERT INTO team_ssh_keys (team_id, public_key, fingerprint, private_key_encrypted)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (team_id) DO UPDATE SET
		   public_key = $2, fingerprint = $3, private_key_encrypted = $4`,
		[teamId, sshPublicKey, fingerprint, encryptedPrivateKey],
	);

	return { publicKey: sshPublicKey, fingerprint };
}

export async function getTeamSSHKey(
	db: PGlite,
	teamId: string,
	masterKeyManager: MasterKeyManager,
): Promise<{ publicKey: string; privateKey: string } | null> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const result = await db.query<{
		public_key: string;
		private_key_encrypted: string;
	}>(
		`SELECT public_key, private_key_encrypted
		 FROM team_ssh_keys
		 WHERE team_id = $1`,
		[teamId],
	);

	if (result.rows.length === 0) return null;

	const row = result.rows[0];
	return {
		publicKey: row.public_key,
		privateKey: decrypt(row.private_key_encrypted, encryptionKey),
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
