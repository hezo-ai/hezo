import { describe, expect, it } from 'vitest';
import { generateMnemonic, normalizeMnemonic, validateMnemonic } from '../src/crypto/mnemonic';

describe('generateMnemonic', () => {
	it('produces a valid 12-word BIP39 phrase', () => {
		const m = generateMnemonic();
		expect(m.split(' ')).toHaveLength(12);
		expect(validateMnemonic(m)).toBe(true);
	});

	it('produces a fresh phrase each call', () => {
		expect(generateMnemonic()).not.toBe(generateMnemonic());
	});
});

describe('normalizeMnemonic', () => {
	it('trims, collapses whitespace, and lowercases', () => {
		expect(normalizeMnemonic('  Hello   World\n\tFoo ')).toBe('hello world foo');
	});
});

describe('validateMnemonic', () => {
	it('accepts a valid phrase regardless of case/whitespace', () => {
		const valid = ' LEGAL winner thank year wave sausage worth useful legal winner thank yellow ';
		expect(validateMnemonic(valid)).toBe(true);
	});

	it('rejects a non-BIP39 phrase', () => {
		expect(validateMnemonic('foo bar baz')).toBe(false);
	});
});
