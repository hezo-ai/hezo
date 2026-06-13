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

export function extractPlaceholderNames(input: string): string[] {
	const names = new Set<string>();
	for (const match of input.matchAll(createPlaceholderRegex())) {
		names.add(match[1]);
	}
	return [...names];
}
