import { describe, expect, it } from 'vitest';
import {
	connectorHasPlaceholderHeader,
	containsCredentialPlaceholder,
	createPlaceholderRegex,
	credentialPlaceholder,
	SECRET_NAME_PATTERN,
} from '../src/credentials/placeholder';

describe('the placeholder grammar', () => {
	it('renders and matches the same spelling', () => {
		const rendered = credentialPlaceholder('STRIPE_KEY');
		expect(rendered).toBe('__HEZO_SECRET_STRIPE_KEY__');
		expect(containsCredentialPlaceholder(rendered)).toBe(true);
		expect([...rendered.matchAll(createPlaceholderRegex())][0][1]).toBe('STRIPE_KEY');
	});

	it('accepts only names the validator accepts', () => {
		for (const name of ['A', 'STRIPE_KEY', 'K9', 'A'.repeat(64)]) {
			expect(SECRET_NAME_PATTERN.test(name)).toBe(true);
			expect(containsCredentialPlaceholder(credentialPlaceholder(name))).toBe(true);
		}
		for (const name of ['lower', '9LEADING', 'HAS-DASH', '', 'A'.repeat(65)]) {
			expect(SECRET_NAME_PATTERN.test(name)).toBe(false);
			expect(containsCredentialPlaceholder(credentialPlaceholder(name))).toBe(false);
		}
	});

	it('hands back a fresh regex so a global lastIndex cannot leak between calls', () => {
		const text = `${credentialPlaceholder('ONE')} ${credentialPlaceholder('TWO')}`;
		expect([...text.matchAll(createPlaceholderRegex())].map((m) => m[1])).toEqual(['ONE', 'TWO']);
		expect([...text.matchAll(createPlaceholderRegex())].map((m) => m[1])).toEqual(['ONE', 'TWO']);
	});

	it('finds a placeholder anywhere in a header value, repeatably', () => {
		const config = { headers: { Authorization: 'Bearer __HEZO_SECRET_TYPEFULLY__' } };
		// Called twice on purpose: the shared matcher must not carry state.
		expect(connectorHasPlaceholderHeader(config)).toBe(true);
		expect(connectorHasPlaceholderHeader(config)).toBe(true);
	});

	it('reads no placeholder off a config that carries none', () => {
		expect(connectorHasPlaceholderHeader(null)).toBe(false);
		expect(connectorHasPlaceholderHeader({})).toBe(false);
		expect(connectorHasPlaceholderHeader({ headers: {} })).toBe(false);
		expect(connectorHasPlaceholderHeader({ headers: { 'X-Trace': 'on' } })).toBe(false);
		expect(connectorHasPlaceholderHeader({ headers: { 'X-Key': '__HEZO_SECRET_lower__' } })).toBe(
			false,
		);
		// A non-string value must not be coerced into a match.
		expect(connectorHasPlaceholderHeader({ headers: { 'X-Key': 42 } })).toBe(false);
	});
});
