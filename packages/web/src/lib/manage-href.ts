/**
 * Where `manage_url` may be followed, or null when it may not.
 *
 * Validated as `https:` at parse and again here - React does not reliably block
 * a `javascript:` href, and this string is operator-authored. No query params and
 * no token: the URL lands in access logs and in browser history, and a top-level
 * navigation already carries the session cookie.
 */
export function manageHref(
	policy: { manage_url: string | null } | null | undefined,
): string | null {
	const url = policy?.manage_url;
	return url?.startsWith('https://') ? url : null;
}

/**
 * Where more container-hours are bought, or null when buying is not how they
 * are raised.
 *
 * Only a pinned allowance is moved by buying: one the operator set is edited on
 * HQ's Hours tab, and an instance nobody manages has nowhere to buy from. Both
 * the instance settings and the hours read carry the two fields this needs.
 */
export function buyHoursHref(
	source:
		| { monthly_hours_pinned: boolean; policy: { manage_url: string | null } | null }
		| null
		| undefined,
): string | null {
	return source?.monthly_hours_pinned ? manageHref(source.policy) : null;
}
