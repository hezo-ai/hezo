import { generateMnemonic, normalizeMnemonic, validateMnemonic } from '@hezo/shared';
import { describe, expect, it } from 'vitest';

// Canonical BIP39 test vector (the all-"abandon" phrase). The derived-key
// pins for this vector live in auth-crypto.test.ts.
const VECTOR =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('mnemonic', () => {
	it('generates a valid 12-word phrase', () => {
		const phrase = generateMnemonic();
		expect(phrase.split(' ')).toHaveLength(12);
		expect(validateMnemonic(phrase)).toBe(true);
	});

	it('generates distinct phrases', () => {
		expect(generateMnemonic()).not.toBe(generateMnemonic());
	});

	it('normalizes whitespace, newlines and case', () => {
		const messy = `  ABANDON   abandon\tabandon abandon abandon abandon
			abandon abandon abandon abandon abandon ABOUT  `;
		expect(normalizeMnemonic(messy)).toBe(VECTOR);
		expect(validateMnemonic(messy)).toBe(true);
	});

	it('rejects invalid phrases without throwing', () => {
		expect(validateMnemonic('')).toBe(false);
		expect(validateMnemonic('not a real phrase at all here please thanks')).toBe(false);
		// Valid words, 12 of them, but a broken checksum (last word swapped).
		expect(
			validateMnemonic(
				'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
			),
		).toBe(false);
	});
});
