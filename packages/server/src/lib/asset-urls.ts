import { createHmac, timingSafeEqual } from 'node:crypto';
import { ATTACHMENT_SIGNED_URL_TTL_SECONDS } from '@hezo/shared';
import { deriveKey } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';

const KEY_PURPOSE = 'asset-url';

async function getSigningKey(masterKeyManager: MasterKeyManager): Promise<Buffer> {
	const unlockKeyHex = masterKeyManager.getUnlockKeyHex();
	if (!unlockKeyHex) throw new Error('Master key not available');
	return deriveKey(unlockKeyHex, KEY_PURPOSE);
}

export async function signAssetUrl(
	assetId: string,
	masterKeyManager: MasterKeyManager,
	ttlSeconds: number = ATTACHMENT_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
	const key = await getSigningKey(masterKeyManager);
	const sig = createHmac('sha256', key).update(`${assetId}|${exp}`).digest('base64url');
	return `/api/assets/${assetId}?exp=${exp}&sig=${sig}`;
}

export async function verifyAssetUrl(
	assetId: string,
	exp: number,
	sig: string,
	masterKeyManager: MasterKeyManager,
): Promise<boolean> {
	if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) return false;
	const key = await getSigningKey(masterKeyManager);
	const expected = createHmac('sha256', key).update(`${assetId}|${exp}`).digest('base64url');
	if (sig.length !== expected.length) return false;
	try {
		return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
	} catch {
		return false;
	}
}
