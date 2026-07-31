import { createHmac, timingSafeEqual } from 'node:crypto';
import { ATTACHMENT_SIGNED_URL_TTL_SECONDS } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { dockerRunEndpoints } from '../services/sandbox/endpoints';

const KEY_PURPOSE = 'asset-url';

/** Memoized on the manager — see entity-icon-urls.ts for why this matters. */
function getSigningKey(masterKeyManager: MasterKeyManager): Promise<Buffer> {
	return masterKeyManager.getDerivedKey(KEY_PURPOSE);
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

/**
 * Agent-facing asset URLs are long-lived: a run can span hours and an agent
 * may fetch an attachment late in it. An expired URL is always recoverable —
 * the agent re-calls `read_project_asset` / `list_comments` for a fresh one —
 * and each URL grants exactly one asset, far tighter than the whole-project
 * read-only bind mount it replaced.
 */
export const AGENT_ASSET_URL_TTL_SECONDS = 24 * 60 * 60;

/**
 * Absolute, signed download URL usable from inside an agent container. Agents
 * reach the host over the backend's Hezo origin (see `sandbox/endpoints.ts`) —
 * the same origin as
 * the MCP endpoint — which the per-run egress proxy exempts via NO_PROXY, so a
 * plain `curl <url>` works with no proxy or auth header.
 */
export async function signAgentAssetUrl(
	assetId: string,
	masterKeyManager: MasterKeyManager,
	serverPort: number,
): Promise<string> {
	const path = await signAssetUrl(assetId, masterKeyManager, AGENT_ASSET_URL_TTL_SECONDS);
	return `${dockerRunEndpoints(serverPort).hezoBaseUrl}${path}`;
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
