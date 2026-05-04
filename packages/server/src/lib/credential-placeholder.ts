export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export const PLACEHOLDER_PATTERN = /__HEZO_SECRET_([A-Z][A-Z0-9_]{0,63})__/g;

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
	return `__HEZO_SECRET_${name}__`;
}

export function extractPlaceholderNames(input: string): string[] {
	const names = new Set<string>();
	for (const match of input.matchAll(PLACEHOLDER_PATTERN)) {
		names.add(match[1]);
	}
	return [...names];
}
