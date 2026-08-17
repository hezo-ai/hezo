// Single source of truth for the secret-name grammar and the egress
// placeholder. The same grammar gates four things that MUST agree, or a secret
// becomes either un-referenceable or silently un-substitutable:
//   1. `request_credential` (validates the name an agent asks for)
//   2. the admin `POST /secrets` route (validates the name an operator stores)
//   3. the egress proxy substitution (matches the placeholder at request time)
//   4. the connector gate (a header carrying one counts as a credential)
// It lives in the shared package because the last of those is derived on both
// sides. Keep the grammar here and nowhere else.

/** Body of a secret name: an uppercase letter, then up to 63 more uppercase
 * letters / digits / underscores (max 64 chars total). */
export const SECRET_NAME_BODY = '[A-Z][A-Z0-9_]{0,63}';

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

export function credentialPlaceholder(name: string): string {
	return `${PLACEHOLDER_PROBE}${name}__`;
}

/**
 * True when a hosted connector's static headers carry a credential placeholder.
 *
 * Such a connector authenticates through the egress proxy, which substitutes
 * the real value at request time. Nothing on this side can reproduce that, so
 * a server-side probe of it always goes out unauthenticated and its answer says
 * nothing about whether the connector works in a run. Both the run gate and the
 * status ladder read this to keep from judging a connector on evidence that
 * could not have been gathered.
 */
export function connectorHasPlaceholderHeader(config: unknown): boolean {
	const headers = (config as { headers?: unknown } | null)?.headers;
	if (!headers || typeof headers !== 'object') return false;
	return Object.values(headers as Record<string, unknown>).some(
		(v) => typeof v === 'string' && containsCredentialPlaceholder(v),
	);
}

/** True when a string carries a credential placeholder anywhere in it. */
export function containsCredentialPlaceholder(value: string): boolean {
	return CONTAINS_PLACEHOLDER.test(value);
}

/** Non-global twin of {@link createPlaceholderRegex}: safe to share, because it
 * carries no `lastIndex` to leak between calls. */
const CONTAINS_PLACEHOLDER = new RegExp(`${PLACEHOLDER_PROBE}${SECRET_NAME_BODY}__`);
