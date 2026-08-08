// Single source of truth for the secret-name grammar and the egress
// placeholder. The same grammar gates three things that MUST agree, or a
// secret becomes either un-referenceable or silently un-substitutable:
//   1. `request_credential` (validates the name an agent asks for)
//   2. the admin `POST /secrets` route (validates the name an operator stores)
//   3. the egress proxy substitution (matches the placeholder at request time)
// Keep the grammar here and nowhere else.

/** Body of a secret name: an uppercase letter, then up to 63 more uppercase
 * letters / digits / underscores (max 64 chars total). */
const SECRET_NAME_BODY = '[A-Z][A-Z0-9_]{0,63}';

export const SECRET_NAME_PATTERN = new RegExp(`^${SECRET_NAME_BODY}$`);

/** Literal prefix every placeholder starts with. Used as a cheap pre-scan
 * before running the full (more expensive) match. */
export const PLACEHOLDER_PROBE = '__HEZO_SECRET_';

/**
 * A fresh global-flagged regex matching `__HEZO_SECRET_<NAME>__`, where
 * `<NAME>` obeys {@link SECRET_NAME_PATTERN}. Returns a NEW instance on every
 * call: a global regex carries mutable `lastIndex`, so a shared instance used
 * across `.test()` / `.exec()` / `.replace()` callers would interfere with
 * itself. Callers that need a stable handle should hold their own.
 */
export function createPlaceholderRegex(): RegExp {
	return new RegExp(`${PLACEHOLDER_PROBE}(${SECRET_NAME_BODY})__`, 'g');
}

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

export function credentialPlaceholder(name: string): string {
	return `${PLACEHOLDER_PROBE}${name}__`;
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
