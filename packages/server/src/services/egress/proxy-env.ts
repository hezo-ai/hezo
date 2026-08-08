import { formatEgressProxyUrl } from './proxy';

/**
 * A run's egress proxy as the *container* addresses it.
 *
 * Always the tunnel's container-loopback endpoint, never the host allocation
 * behind it: a container has no route to Hezo's loopback on any backend, so an
 * entry naming the host address would only ever work on local Docker.
 */
export interface EgressProxyEndpoint {
	host: string;
	port: number;
	/** Per-run proxy token, or `null` when egress-proxy auth is disabled. */
	token: string | null;
}

/**
 * The `HTTP(S)_PROXY` / `NO_PROXY` entries every in-container HTTP client needs
 * in order to reach the egress proxy - and therefore the only way a
 * `__HEZO_SECRET_<NAME>__` placeholder ever gets substituted into a request.
 *
 * **Shared because forgetting it is silent.** This used to be inline in
 * `buildRunEnv`, which meant only the agent CLI ever got it. Git did not: once
 * transport moved from SSH to HTTPS, every in-container clone/fetch/push
 * authenticated with a URL credential the proxy was supposed to substitute,
 * connected direct instead, and shipped the literal placeholder as its Basic
 * password. GitHub answers that with `Invalid username or token`, which reads
 * as a bad credential rather than as a request that never reached the proxy -
 * so the failure names the wrong thing and the real token is never at fault.
 *
 * Nothing here is client-specific. Git reads these the way curl and every
 * runtime's HTTP stack do, which is the point: no caller needs its own idea of
 * how a container reaches the proxy.
 *
 * @param extraDirectHosts hosts that must bypass the proxy on top of the
 *   loopback defaults - the model-provider upstreams a run sends direct
 *   (AGENTS.md red line, sole exception). Callers with nothing to exempt pass
 *   nothing.
 */
export function buildEgressProxyEnv(
	endpoint: EgressProxyEndpoint,
	extraDirectHosts: readonly string[] = [],
): string[] {
	// Per-run token rides the userinfo so every client sends it as
	// Proxy-Authorization; the proxy 407s any caller without it. A non-null
	// token here means auth is on (the default).
	const proxyUrl = formatEgressProxyUrl(endpoint.host, endpoint.port, endpoint.token);
	const noProxyHosts = [
		endpoint.host,
		'localhost',
		'127.0.0.1',
		// The Hezo MCP endpoint and agent asset URLs arrive on container loopback,
		// where the tunnel client listens — covered by the `127.0.0.1`/`localhost`
		// entries above. MCP auth there is a real per-run JWT and asset URLs are
		// HMAC-signed, so there is no `__HEZO_SECRET_*__` placeholder to
		// substitute: routing them through the proxy would buy nothing and add a
		// hop on every (potentially multi-MB) binary read. Connector MCP servers
		// live on their own remote hosts (reached via HTTPS CONNECT) and still
		// traverse the proxy.
		...extraDirectHosts,
	];
	const noProxy = [...new Set(noProxyHosts)].join(',');
	return [
		`HTTP_PROXY=${proxyUrl}`,
		`http_proxy=${proxyUrl}`,
		`HTTPS_PROXY=${proxyUrl}`,
		`https_proxy=${proxyUrl}`,
		`NO_PROXY=${noProxy}`,
		`no_proxy=${noProxy}`,
	];
}
