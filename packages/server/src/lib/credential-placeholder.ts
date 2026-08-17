// Server-side half of the secret-name machinery. The grammar itself - the name
// pattern, the placeholder spelling and the regex over it - lives in
// `@hezo/shared`, because the connector run gate and the status ladder derive
// from it on both sides. It is re-exported here so every existing import site
// keeps one place to reach for.
//
// What stays here is what only the server does: validating a name an agent or
// operator supplied, normalizing the hosts a secret is scoped to, and pulling
// the names back out of text.

import { createPlaceholderRegex, SECRET_NAME_PATTERN } from '@hezo/shared';

export {
	createPlaceholderRegex,
	credentialPlaceholder,
	PLACEHOLDER_PROBE,
	SECRET_NAME_BODY,
	SECRET_NAME_PATTERN,
} from '@hezo/shared';

export function validateSecretName(
	name: string,
): { valid: true } | { valid: false; error: string } {
	if (typeof name !== 'string' || name.length === 0) {
		return { valid: false, error: 'name is required' };
	}
	if (!SECRET_NAME_PATTERN.test(name)) {
		return {
			valid: false,
			error:
				'name must match [A-Z][A-Z0-9_]{0,63} (uppercase letter followed by uppercase letters, digits, or underscores; max 64 chars)',
		};
	}
	return { valid: true };
}

/**
 * Normalize one `allowed_hosts` entry to the exact shape the egress proxy
 * compares against.
 *
 * The proxy matches a **bare lowercase hostname** — it strips the port from the
 * CONNECT target before comparing (`services/egress/substitution.ts`
 * `hostMatchesAllowlist`). So an entry written the way a human naturally writes
 * a host — `https://api.stripe.com`, `api.stripe.com:443`, `api.stripe.com/v1` —
 * could never match anything, and the failure was silent: the secret simply
 * stopped substituting, with a 403 that looked like a scoping decision rather
 * than a typo. Stripping here cannot widen the scope, because the discarded
 * parts were never consulted in the first place.
 *
 * Returns null when nothing usable is left.
 */
function normalizeAllowedHost(raw: string): string | null {
	let host = raw.trim().toLowerCase();
	if (host.length === 0) return null;
	host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
	const at = host.lastIndexOf('@');
	if (at !== -1) host = host.slice(at + 1); // userinfo
	host = host.split('/')[0].split('?')[0].split('#')[0]; // path/query/fragment
	if (host.startsWith('[')) {
		// IPv6 literal: keep the brackets' contents, drop any :port after them.
		const close = host.indexOf(']');
		host = close === -1 ? host.slice(1) : host.slice(1, close);
	} else {
		const colon = host.lastIndexOf(':');
		if (colon !== -1) host = host.slice(0, colon); // port
	}
	host = host.replace(/\.$/, ''); // fully-qualified trailing dot
	return host.length > 0 ? host : null;
}

/** Normalize a whole `allowed_hosts` array: trim, lowercase, strip
 * scheme/userinfo/path/port, drop empties and duplicates. Shared by every path
 * that writes `secrets.allowed_hosts` so they all store hosts identically. */
export function normalizeAllowedHosts(hosts: unknown): string[] {
	if (!Array.isArray(hosts)) return [];
	const out: string[] = [];
	for (const h of hosts) {
		const host = normalizeAllowedHost(String(h));
		if (host && !out.includes(host)) out.push(host);
	}
	return out;
}

export function extractPlaceholderNames(input: string): string[] {
	const names = new Set<string>();
	for (const match of input.matchAll(createPlaceholderRegex())) {
		names.add(match[1]);
	}
	return [...names];
}
