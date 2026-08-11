import { createHmac, timingSafeEqual } from 'node:crypto';
import { ATTACHMENT_SIGNED_URL_TTL_SECONDS } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';

// An entity icon (an agent's or the admin user's avatar) is rendered in an
// `<img>` tag, which cannot carry a bearer token, so it is served from a public
// endpoint guarded by an HMAC-signed URL — the same pattern as the project icon
// (`lib/project-icon-urls.ts`), generalized so a new entity is a `basePath` +
// `keyPurpose` pair rather than a copied file. Each purpose derives a distinct
// signing key, so a signature for one entity kind can never be replayed on
// another.

/**
 * Memoized on the manager: this runs once per signed URL, and a feed signs one
 * per row, so deriving here would put an HKDF round trip on every row rendered.
 */
function getSigningKey(masterKeyManager: MasterKeyManager, keyPurpose: string): Promise<Buffer> {
	return masterKeyManager.getDerivedKey(keyPurpose);
}

/**
 * Sign a time-limited URL for an entity's icon. `version` (the icon's
 * `updated_at` epoch) is appended as an unsigned `v` query param so the `<img>`
 * cache busts when the icon changes, while the signature only covers the entity
 * id + expiry. `basePath` is the collection path (e.g. `/api/agents`),
 * `keyPurpose` the per-entity key label (e.g. `agent-icon-url`).
 */
export async function signEntityIconUrl(
	basePath: string,
	keyPurpose: string,
	id: string,
	masterKeyManager: MasterKeyManager,
	version: number,
	ttlSeconds: number = ATTACHMENT_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
	const key = await getSigningKey(masterKeyManager, keyPurpose);
	const sig = createHmac('sha256', key).update(`${id}|${exp}`).digest('base64url');
	return `${basePath}/${id}/icon?exp=${exp}&sig=${sig}&v=${version}`;
}

export interface EntityIconUrlConfig {
	/** Collection path the icon is served from, e.g. `/api/agents`. */
	basePath: string;
	/** Per-entity signing-key label, e.g. `agent-icon-url`. */
	keyPurpose: string;
}

// The one entity kind that carries an uploaded avatar. This MUST match the
// constant the serving endpoint verifies against (routes/users.ts) — a mismatch
// yields a signature the `<img>` can't verify. Agents deliberately have no entry:
// an agent's avatar is generated from its `avatar_spec`, never uploaded, so
// there is nothing to serve or sign.
export const USER_ICON_URL: EntityIconUrlConfig = {
	basePath: '/api/users',
	keyPurpose: 'user-icon-url',
};

/**
 * Sign an entity's icon URL from its icon-table `updated_at` (the cache-busting
 * version), or return null when the entity has no icon (`updated_at` absent).
 * The single place every list/feed query turns an `icon_updated_at` column into a
 * signed avatar URL, so the signing scheme lives in one spot.
 */
export async function signVersionedIconUrl(
	config: EntityIconUrlConfig,
	id: string,
	iconUpdatedAt: unknown,
	masterKeyManager: MasterKeyManager,
): Promise<string | null> {
	if (typeof iconUpdatedAt === 'string' || iconUpdatedAt instanceof Date) {
		const version = Math.floor(new Date(iconUpdatedAt).getTime() / 1000);
		return signEntityIconUrl(config.basePath, config.keyPurpose, id, masterKeyManager, version);
	}
	return null;
}

/**
 * The signed avatar URL for whoever authored/requested a row in a feed: a human
 * resolves to their `user_icons` image (keyed by `userId`). An agent author has
 * none - its avatar is drawn client-side from the `avatar_spec` the row carries -
 * and an API-key author has neither.
 *
 * Best-effort by design — a signing failure (e.g. the master key being
 * unavailable) yields null so the row degrades to its initials fallback rather
 * than failing the whole feed. The avatar is purely cosmetic.
 */
export async function signAuthorIconUrl(
	masterKeyManager: MasterKeyManager,
	author: { userId?: unknown; userIconUpdatedAt?: unknown },
): Promise<string | null> {
	try {
		if (author.userId) {
			return await signVersionedIconUrl(
				USER_ICON_URL,
				author.userId as string,
				author.userIconUpdatedAt,
				masterKeyManager,
			);
		}
	} catch {
		return null;
	}
	return null;
}

export async function verifyEntityIconUrl(
	keyPurpose: string,
	id: string,
	exp: number,
	sig: string,
	masterKeyManager: MasterKeyManager,
): Promise<boolean> {
	if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) return false;
	const key = await getSigningKey(masterKeyManager, keyPurpose);
	const expected = createHmac('sha256', key).update(`${id}|${exp}`).digest('base64url');
	if (sig.length !== expected.length) return false;
	try {
		return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
	} catch {
		return false;
	}
}
