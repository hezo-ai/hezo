import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Destination guard for the per-run egress proxy.
 *
 * The proxy runs in the **host's** network namespace and will dial whatever an
 * authenticated caller names. Without this guard an agent could `CONNECT
 * 127.0.0.1:5432` (or `host.docker.internal:<serverPort>`) and reach Hezo's own
 * API, its database, or any other daemon bound to the host — a server-side
 * request forgery primitive handed out with the proxy token. `NO_PROXY` does not
 * prevent it: that is a client-side hint the agent controls, not an enforcement
 * point.
 *
 * Blocking is by **resolved address**, not by name, because a hostname is not
 * evidence of anything — `evil.example.com A 127.0.0.1` resolves straight back to
 * the host. The caller resolves through `resolveGuardedAddress` and then dials
 * the address it returned, so the address that was checked is the address that
 * is connected to and there is no TOCTOU gap. It is deliberately not the
 * request's `lookup` option; see that function for what that cost.
 *
 * Legitimate traffic is unaffected: the container's `NO_PROXY` already carves out
 * `host.docker.internal`, `localhost` and the LLM provider host, so nothing that
 * is supposed to reach a private address goes through the proxy in the first
 * place. An operator running an MCP server or git remote on their LAN is the one
 * real case, and that is what `--egress-allow-private-targets` is for.
 */

/** Parse a dotted-quad into its four octets, or null if it is not one. */
function ipv4Octets(address: string): [number, number, number, number] | null {
	const parts = address.split('.');
	if (parts.length !== 4) return null;
	const nums = parts.map((p) => Number(p));
	if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
	return [nums[0], nums[1], nums[2], nums[3]];
}

/**
 * True when the address is one the agent has no business reaching through the
 * proxy: loopback, unspecified, link-local (incl. the cloud metadata address
 * 169.254.169.254), private/RFC1918, carrier-grade NAT, and their IPv6
 * equivalents (::1, ::, fe80::/10 link-local, fc00::/7 unique-local), plus
 * IPv4-mapped IPv6 forms of all of the above.
 */
export function isBlockedEgressAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return false;

	if (family === 6) {
		const v6 = address.toLowerCase().split('%')[0]; // drop any zone index
		if (v6 === '::1' || v6 === '::') return true;
		// IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms re-enter the
		// v4 rules rather than being waved through as "some IPv6 address".
		const mapped = v6.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) return isBlockedEgressAddress(mapped[1]);
		if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link-local
		if (/^f[cd]/.test(v6)) return true; // fc00::/7 unique-local
		return false;
	}

	const octets = ipv4Octets(address);
	if (!octets) return false;
	const [a, b] = octets;
	if (a === 0) return true; // 0.0.0.0/8 "this network"
	if (a === 127) return true; // loopback
	if (a === 10) return true; // RFC1918
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
	if (a === 192 && b === 168) return true; // RFC1918
	if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
	if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 carrier-grade NAT
	return false;
}

/** Thrown when a request targets a blocked address. Carries the resolved
 * address so the proxy can tell the agent *why* without a second lookup. */
export class BlockedEgressTargetError extends Error {
	constructor(
		readonly host: string,
		readonly address: string,
	) {
		super(`egress to ${host} (${address}) is blocked: private or loopback address`);
		this.name = 'BlockedEgressTargetError';
	}
}

/**
 * Resolve a hostname and refuse it if it lands on a blocked address, returning
 * the address the caller must then dial.
 *
 * **Resolve-then-dial rather than a custom `lookup`, and that is not a style
 * choice.** Handing `lookup` to `http(s).request` is the obvious way to close
 * the check/connect gap, and it is broken on the runtime production uses (Bun
 * 1.3.14): a request carrying a **body** never delivers that body, so the
 * upstream answers as though it received an empty one. A `GET` is unaffected,
 * which is what made this so hard to see - a proxied `git` clone fetched its ref
 * advertisement normally and then hung on `POST /git-upload-pack`, and every
 * agent's POSTed API and MCP call was silently sent empty. Bun's `node:http` has
 * a cluster of known proxy defects (oven-sh/bun#28396); this is the one that
 * reached us.
 *
 * Dialing the resolved literal keeps the property the custom lookup existed for:
 * the address that was checked is the address that is connected to, so a name
 * cannot re-resolve to something private in between. The caller must pass the
 * original hostname as `servername` (TLS/SNI and certificate validation) and set
 * the `Host` header from it, since the runtime would otherwise derive `Host`
 * from the address.
 */
export async function resolveGuardedAddress(host: string): Promise<string> {
	const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	// An IP literal needs no resolution - decide on it directly.
	if (isIP(bare) !== 0) {
		if (isBlockedEgressAddress(bare)) throw new BlockedEgressTargetError(host, bare);
		return bare;
	}
	const address = await new Promise<string>((resolve, reject) => {
		dnsLookup(bare, (err, addr) => (err ? reject(err) : resolve(String(addr))));
	});
	if (isBlockedEgressAddress(address)) throw new BlockedEgressTargetError(host, address);
	return address;
}

/**
 * Synchronous pre-check for a CONNECT target, so an obviously-blocked tunnel is
 * refused before a per-host TLS server and leaf cert are minted for it. A
 * hostname passes here and is caught later by {@link resolveGuardedAddress} on
 * the upstream leg; only IP literals are decidable at this point.
 */
export function isBlockedEgressHost(host: string): boolean {
	const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	if (isIP(bare) !== 0) return isBlockedEgressAddress(bare);
	const lower = bare.toLowerCase().replace(/\.$/, '');
	return lower === 'localhost' || lower.endsWith('.localhost');
}

/** Hezo's own endpoint as reached from inside a run's container. */
export interface SelfEndpoint {
	host: string;
	port: number;
}

/**
 * True when the target is Hezo's own MCP/asset endpoint, which the guard must
 * let through.
 *
 * A run's `NO_PROXY` already carves this out, so in practice it never reaches
 * the proxy — but `NO_PROXY` is a client-side convention, and a runtime whose
 * HTTP client ignores it would have its Hezo traffic proxied. Before the guard
 * that still worked; blocking it would turn a hardening change into "no tools
 * load". This is not a new capability either: the run already holds an agent JWT
 * for exactly this endpoint. The port is part of the match, so naming the same
 * host with a different port (Postgres, another daemon) is still refused.
 */
export function isSelfEndpoint(host: string, port: number, self: SelfEndpoint | null): boolean {
	if (!self || port !== self.port) return false;
	return host.toLowerCase().replace(/\.$/, '') === self.host.toLowerCase().replace(/\.$/, '');
}
