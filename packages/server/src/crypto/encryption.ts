import { createCipheriv, createDecipheriv, hkdf, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function encrypt(plaintext: string, key: Buffer): string {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv, {
		authTagLength: AUTH_TAG_LENGTH,
	});
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

export function decrypt(ciphertext: string, key: Buffer): string {
	const data = Buffer.from(ciphertext, 'base64');
	const iv = data.subarray(0, IV_LENGTH);
	const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
	const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);
	const decipher = createDecipheriv(ALGORITHM, key, iv, {
		authTagLength: AUTH_TAG_LENGTH,
	});
	decipher.setAuthTag(authTag);
	return decipher.update(encrypted) + decipher.final('utf8');
}

export function deriveKey(masterKey: string, purpose: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const salt = Buffer.from(purpose, 'utf8');
		hkdf('sha256', masterKey, salt, Buffer.from('hezo', 'utf8'), 32, (err, derivedKey) => {
			if (err) reject(err);
			else resolve(Buffer.from(derivedKey));
		});
	});
}

export function generateMasterKey(): string {
	return randomBytes(32).toString('hex');
}
