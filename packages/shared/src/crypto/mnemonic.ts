import { generateMnemonic as scureGenerate, validateMnemonic as scureValidate } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/** 12-word BIP39 phrase (128-bit entropy). The user-facing master key. */
export function generateMnemonic(): string {
	return scureGenerate(wordlist, 128);
}

/** Trim, collapse whitespace/newlines, lowercase — tolerant of paste. */
export function normalizeMnemonic(phrase: string): string {
	return phrase.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** True iff `phrase` (after normalization) is a valid BIP39 phrase. Never throws. */
export function validateMnemonic(phrase: string): boolean {
	return scureValidate(normalizeMnemonic(phrase), wordlist);
}
