import { logger } from '../../logger';
import { discoverMetadata, type FetchFn, type OAuthMetadata } from './provider-generic';

const log = logger.child('oauth-prm');

/**
 * Protected Resource Metadata (RFC 9728) advertised by an MCP server.
 * Returned by the resource_metadata URL the MCP server points to via
 * `WWW-Authenticate: Bearer resource_metadata="..."`.
 */
export interface ProtectedResourceMetadata {
	resource: string;
	authorization_servers: string[];
	scopes_supported?: string[];
	bearer_methods_supported?: string[];
	resource_documentation?: string;
}

export interface DiscoveryResult {
	resource: string;
	authorizationServerUrl: string;
	prm: ProtectedResourceMetadata;
	asMetadata: OAuthMetadata;
}

/**
 * Build the standard Protected Resource Metadata URL for a resource. We use
 * the origin-level variant (`${origin}/.well-known/oauth-protected-resource`)
 * because that's what real servers publish (DatoCMS, Linear, …), even when
 * the MCP endpoint is at a sub-path. RFC 9728 §3.1's path-aware "insert
 * /.well-known between host and path" variant is rarely served in practice;
 * we can add it as a secondary fallback if a real server forces the issue.
 */
export function wellKnownPrmUrl(mcpUrl: string): string {
	const u = new URL(mcpUrl);
	return `${u.protocol}//${u.host}/.well-known/oauth-protected-resource`;
}

/**
 * Probe an MCP server URL once, expecting either:
 *   (a) a 401 with `WWW-Authenticate: Bearer resource_metadata="..."` per
 *       MCP 2025-06-18 / RFC 9728 — return the pointed-to URL; or
 *   (b) the server advertises PRM only at the standard well-known location
 *       per RFC 9728 §3.1 — fall back to that URL.
 *
 * Returns the URL the caller should `fetchProtectedResourceMetadata` against.
 * Falls back to the well-known URL whenever the WWW-Authenticate-hint path
 * doesn't yield one (401 without the hint, 200/404/405, or network error).
 * Real-world implementations (DatoCMS as of 2026-05) only do (b).
 */
export async function probeForProtectedResourceMetadata(
	mcpUrl: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<string> {
	const fallback = wellKnownPrmUrl(mcpUrl);
	let res: Response;
	try {
		res = await fetchFn(mcpUrl, { method: 'GET', headers: { Accept: 'application/json' } });
	} catch (e) {
		log.debug('MCP probe failed; using well-known fallback', {
			mcpUrl,
			error: (e as Error).message,
		});
		return fallback;
	}
	if (res.status !== 401) {
		log.debug('MCP probe did not yield 401; using well-known fallback', {
			mcpUrl,
			status: res.status,
		});
		return fallback;
	}
	const challenge = res.headers.get('WWW-Authenticate') ?? res.headers.get('www-authenticate');
	if (challenge) {
		const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challenge);
		if (match?.[1]) return match[1];
	}
	log.debug('MCP 401 lacked resource_metadata hint; using well-known fallback', { mcpUrl });
	return fallback;
}

/**
 * Fetch the Protected Resource Metadata document.
 */
export async function fetchProtectedResourceMetadata(
	prmUrl: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<ProtectedResourceMetadata> {
	const res = await fetchFn(prmUrl, { headers: { Accept: 'application/json' } });
	if (!res.ok) {
		throw new Error(`PRM fetch failed: ${prmUrl} → ${res.status}`);
	}
	const data = (await res.json()) as ProtectedResourceMetadata;
	if (!Array.isArray(data.authorization_servers) || data.authorization_servers.length === 0) {
		throw new Error(`PRM at ${prmUrl} missing authorization_servers`);
	}
	return data;
}

/**
 * The MCP server advertises no usable Protected Resource Metadata — neither a
 * WWW-Authenticate hint nor the well-known document. Per MCP 2025-06-18 an
 * OAuth-protected server MUST publish PRM, so this most likely means the
 * server doesn't use OAuth at all (public, or header-authenticated). Callers
 * that probe speculatively (the admin connectors page) treat this as "no
 * OAuth", not as a failure; downstream errors (broken AS metadata, DCR
 * rejection) stay plain Errors because there OAuth *is* advertised but broken.
 */
export class PrmUnavailableError extends Error {}

/**
 * Full discovery walk: probe the MCP server, fetch its PRM, then fetch the
 * advertised Authorization Server's metadata. The single entry point used by
 * the auth-start route for a connector.
 */
export async function discoverMcpAuthorization(
	mcpUrl: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<DiscoveryResult> {
	const prmUrl = await probeForProtectedResourceMetadata(mcpUrl, fetchFn);
	let prm: ProtectedResourceMetadata;
	try {
		prm = await fetchProtectedResourceMetadata(prmUrl, fetchFn);
	} catch (e) {
		throw new PrmUnavailableError(
			`Could not discover OAuth endpoints for ${mcpUrl}: WWW-Authenticate had no resource_metadata pointer, and ${prmUrl} failed (${(e as Error).message})`,
		);
	}
	const asUrl = prm.authorization_servers[0]!;
	const asMetadata = await discoverMetadata(asUrl, fetchFn);
	return {
		resource: prm.resource,
		authorizationServerUrl: asUrl,
		prm,
		asMetadata,
	};
}
