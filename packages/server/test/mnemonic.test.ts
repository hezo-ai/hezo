import {
	generateMnemonic,
	mnemonicToMasterKey,
	normalizeMnemonic,
	validateMnemonic,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';

// Canonical BIP39 test vector (the all-"abandon" phrase). Its seed is the
// well-known 5eb00bbd... value; the first 32 bytes pin our derivation so a
// library/algorithm change is caught.
const VECTOR =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_HEX = '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1';

describe('mnemonic', () => {
	it('generates a valid 12-word phrase', () => {
		const phrase = generateMnemonic();
		expect(phrase.split(' ')).toHaveLength(12);
		expect(validateMnemonic(phrase)).toBe(true);
	});

	it('generates distinct phrases', () => {
		expect(generateMnemonic()).not.toBe(generateMnemonic());
	});

	it('derives the pinned hex for the canonical vector', () => {
		expect(validateMnemonic(VECTOR)).toBe(true);
		const hex = mnemonicToMasterKey(VECTOR);
		expect(hex).toBe(VECTOR_HEX);
		expect(hex).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic', () => {
		expect(mnemonicToMasterKey(VECTOR)).toBe(mnemonicToMasterKey(VECTOR));
	});

	it('normalizes whitespace, newlines and case before deriving', () => {
		const messy = `  ABANDON   abandon\tabandon abandon abandon abandon
			abandon abandon abandon abandon abandon ABOUT  `;
		expect(normalizeMnemonic(messy)).toBe(VECTOR);
		expect(validateMnemonic(messy)).toBe(true);
		expect(mnemonicToMasterKey(messy)).toBe(VECTOR_HEX);
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
