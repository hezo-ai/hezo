import { createHmac, timingSafeEqual } from 'node:crypto';
import { ATTACHMENT_SIGNED_URL_TTL_SECONDS } from '@hezo/shared';
import { deriveKey } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';

// A project icon is rendered in an `<img>` tag, which cannot carry a bearer
// token, so it is served from a public endpoint guarded by an HMAC-signed URL —
// the same pattern as asset reads (`lib/asset-urls.ts`), keyed separately.
const KEY_PURPOSE = 'project-icon-url';

async function getSigningKey(masterKeyManager: MasterKeyManager): Promise<Buffer> {
	const unlockKeyHex = masterKeyManager.getUnlockKeyHex();
	if (!unlockKeyHex) throw new Error('Master key not available');
	return deriveKey(unlockKeyHex, KEY_PURPOSE);
}

/**
 * Sign a time-limited URL for a project's icon. `version` (the icon's
 * `updated_at` epoch) is appended as an unsigned `v` query param so the `<img>`
 * cache busts when the icon changes, while the signature only covers the
 * project id + expiry.
 */
export async function signProjectIconUrl(
	projectId: string,
	masterKeyManager: MasterKeyManager,
	version: number,
	ttlSeconds: number = ATTACHMENT_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
	const key = await getSigningKey(masterKeyManager);
	const sig = createHmac('sha256', key).update(`${projectId}|${exp}`).digest('base64url');
	return `/api/projects/${projectId}/icon?exp=${exp}&sig=${sig}&v=${version}`;
}

export async function verifyProjectIconUrl(
	projectId: string,
	exp: number,
	sig: string,
	masterKeyManager: MasterKeyManager,
): Promise<boolean> {
	if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) return false;
	const key = await getSigningKey(masterKeyManager);
	const expected = createHmac('sha256', key).update(`${projectId}|${exp}`).digest('base64url');
	if (sig.length !== expected.length) return false;
	try {
		return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
	} catch {
		return false;
	}
}
