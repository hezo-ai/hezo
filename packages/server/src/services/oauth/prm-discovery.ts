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
 * Probe an MCP server URL once, expecting a 401 with `WWW-Authenticate: Bearer
 * resource_metadata="..."`. Returns the extracted resource_metadata URL, or
 * null when the server responded successfully (no auth needed) or with a
 * different challenge.
 */
export async function probeForProtectedResourceMetadata(
	mcpUrl: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<string | null> {
	let res: Response;
	try {
		res = await fetchFn(mcpUrl, { method: 'GET', headers: { Accept: 'application/json' } });
	} catch (e) {
		throw new Error(`MCP server probe failed: ${(e as Error).message}`);
	}
	if (res.status !== 401) {
		log.debug('MCP probe did not yield 401', { mcpUrl, status: res.status });
		return null;
	}
	const challenge = res.headers.get('WWW-Authenticate') ?? res.headers.get('www-authenticate');
	if (!challenge) return null;
	const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challenge);
	return match?.[1] ?? null;
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
 * Full discovery walk: probe the MCP server, fetch its PRM, then fetch the
 * advertised Authorization Server's metadata. The single entry point used by
 * the auth-start route for a connector.
 */
export async function discoverMcpAuthorization(
	mcpUrl: string,
	fetchFn: FetchFn = globalThis.fetch,
): Promise<DiscoveryResult> {
	const prmUrl = await probeForProtectedResourceMetadata(mcpUrl, fetchFn);
	if (!prmUrl) {
		throw new Error(
			`MCP server at ${mcpUrl} did not advertise PRM via WWW-Authenticate; cannot discover OAuth endpoints`,
		);
	}
	const prm = await fetchProtectedResourceMetadata(prmUrl, fetchFn);
	const asUrl = prm.authorization_servers[0]!;
	const asMetadata = await discoverMetadata(asUrl, fetchFn);
	return {
		resource: prm.resource,
		authorizationServerUrl: asUrl,
		prm,
		asMetadata,
	};
}
