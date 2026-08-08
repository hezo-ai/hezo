/**
 * Does a host fall inside a secret's `allowed_hosts`?
 *
 * One definition, because three had grown and two of them disagreed about the
 * syntax. `allowed_hosts` stores wildcards as `*.example.com` - that is the
 * shape the connector registry ships (`*.datocms.com`, `*.sentry.io`) and the
 * shape the egress proxy enforces. The tunnel's split-routing policy and its
 * in-container client had each been written against a leading-dot form
 * (`.example.com`) instead, so `*.datocms.com` matched **nothing** there: the
 * container routed the request direct, past the proxy, and the placeholder
 * arrived at DatoCMS unsubstituted. Every wildcard-scoped credential was broken,
 * and it failed as a 401 from the provider rather than as anything naming the
 * cause.
 *
 * Living in the shared package is deliberate: the proxy decides whether to
 * *substitute* and the tunnel decides whether to *route through the proxy*, and
 * those two answers must be the same answer. A copy of this in each is a copy
 * that eventually disagrees, which is how this arose.
 *
 * Matching rules, which are the **egress proxy's existing rules** - unifying the
 * three copies deliberately did not change where a secret may be sent:
 * - `example.com` matches that host exactly.
 * - `*.example.com` matches any subdomain, and **not** the apex. That follows
 *   the convention TLS certificates and cookie domains use, and the shipped
 *   connector registry assumes it - `sentry` lists `sentry.io` *and*
 *   `*.sentry.io`, which would be redundant under the other reading.
 * - Comparison is case-insensitive, since DNS is.
 *
 * The in-container tunnel client (`docker/scripts/hezo-tunnel`) cannot import
 * this - it is a plain Node script baked into the image - so it carries a
 * hand-written copy. That copy is exercised as the real script, spawned and
 * driven over real sockets, in `sandbox-tunnel-client.test.ts`; keep the two in
 * step when either changes.
 */
export function hostMatchesAllowedHosts(host: string, allowedHosts: readonly string[]): boolean {
	const target = host.trim().toLowerCase();
	if (target.length === 0) return false;
	for (const raw of allowedHosts) {
		const entry = raw.trim().toLowerCase();
		if (entry.length === 0) continue;
		if (entry.startsWith('*.')) {
			if (target.endsWith(entry.slice(1))) return true;
		} else if (target === entry) {
			return true;
		}
	}
	return false;
}
