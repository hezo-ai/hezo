import type { Db } from '../../../db/database';
import type { McpDescriptor } from '../../mcp-injectors/types';

/**
 * Which hosts a container must send through Hezo's egress proxy, and which it
 * may reach directly.
 *
 * Today every request from a container transits the MITM proxy. Under the
 * tunnel that is wasteful in both directions - `apt`, `npm` and
 * `playwright install --with-deps` would push their whole payload through the
 * Hezo instance - so the tunnel client proxies only the hosts that need a
 * security check and connects the rest directly.
 *
 * **Routing the rest directly is not a weakening.** A host appearing in no
 * secret's `allowed_hosts` would have been rejected by the proxy anyway with
 * `secret_not_allowed_for_host`, so the placeholder travels unsubstituted and
 * fails upstream either way. The decision living inside the container is safe
 * for the same reason: subverting it can only *lose* the agent a secret, never
 * gain one.
 *
 * The list is **derived, never hand-written** - a hand-maintained copy would
 * drift from the vault the first time somebody added a secret. It contains
 * hostnames only, never a secret value.
 */

export interface TunnelHostPolicy {
	/**
	 * Hosts that must go through the proxy. Matched by the tunnel client as an
	 * exact host or a `.suffix` match, the same shape `allowed_hosts` already
	 * uses.
	 */
	proxiedHosts: string[];
	/**
	 * Every host must be proxied, because some secret is scoped to all of them.
	 *
	 * This is the one setting that defeats split routing entirely. Secrets are
	 * instance-global - the vault query is unscoped - so a single
	 * `allow_all_hosts` secret forces every run on the instance to proxy
	 * everything. That is a reason to keep `request_credential`'s requirement
	 * that HTTP-auth kinds pass explicit hosts, not a reason to special-case it
	 * here.
	 */
	proxyEverything: boolean;
}

/**
 * Build the policy for a run.
 *
 * Two sources, and both are needed for a different reason:
 *
 * 1. **Every secret's `allowed_hosts`** - a request to one of these may have a
 *    value substituted into it, so it has to reach the proxy to get one.
 * 2. **Every connector MCP host** - the per-connector method allowlist
 *    (`shouldBlockMcpRequest`) is enforced *at the proxy*, so a connector host
 *    routed directly would silently skip its policy check even though no secret
 *    is involved.
 *
 * Missing either would be a security gap rather than a performance one, which
 * is why they are read here together rather than at two call sites.
 *
 * The connector hosts come from the run's **already-built descriptors** rather
 * than a second query. The URL lives inside a JSONB `config` and the resolution
 * skips rows whose URL will not parse, so re-deriving it here would be a second
 * implementation of that logic - and the one that silently disagreed would be
 * this one, since nothing exercises it directly.
 */
export async function buildTunnelHostPolicy(
	db: Db,
	descriptors: readonly McpDescriptor[],
): Promise<TunnelHostPolicy> {
	const secrets = await db.query<{ allowed_hosts: string[] | null; allow_all_hosts: boolean }>(
		`SELECT allowed_hosts, allow_all_hosts FROM secrets`,
	);
	if (secrets.rows.some((r) => r.allow_all_hosts)) {
		return { proxiedHosts: [], proxyEverything: true };
	}

	const hosts = new Set<string>();
	for (const row of secrets.rows) {
		for (const host of row.allowed_hosts ?? []) addHost(hosts, host);
	}
	for (const descriptor of descriptors) {
		if (descriptor.kind !== 'http') continue;
		try {
			addHost(hosts, new URL(descriptor.url).hostname);
		} catch {
			// A descriptor that got this far has a parseable URL; be defensive
			// anyway rather than let one bad row take the whole policy down.
		}
	}

	return { proxiedHosts: [...hosts].sort(), proxyEverything: false };
}

function addHost(into: Set<string>, raw: string): void {
	const host = raw.trim().toLowerCase();
	if (host.length > 0) into.add(host);
}

/**
 * Whether `host` must be proxied under `policy`.
 *
 * Exported because the tunnel client applies the same rule inside the container
 * and a second implementation would eventually disagree with this one - the
 * kind of divergence that shows up as a secret quietly failing to substitute.
 *
 * A leading-dot entry matches the domain and its subdomains; anything else is
 * an exact host match. Comparison is case-insensitive, since DNS is.
 */
export function hostNeedsProxy(policy: TunnelHostPolicy, host: string): boolean {
	if (policy.proxyEverything) return true;
	const target = host.trim().toLowerCase();
	return policy.proxiedHosts.some((entry) =>
		entry.startsWith('.') ? target === entry.slice(1) || target.endsWith(entry) : target === entry,
	);
}
