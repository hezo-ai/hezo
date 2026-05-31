import { bytesToHex } from '@noble/hashes/utils';
import {
	mnemonicToSeedSync,
	generateMnemonic as scureGenerate,
	validateMnemonic as scureValidate,
} from '@scure/bip39';
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

/**
 * Deterministic words -> 64-hex-char internal master key. Takes the first 32
 * bytes of the BIP39 seed so the string handed to the server keeps the
 * historical [0-9a-f]{64} shape. Identical output in the browser (esbuild) and
 * Node/Bun (pure JS, no node:crypto).
 */
export function mnemonicToMasterKey(phrase: string): string {
	const seed = mnemonicToSeedSync(normalizeMnemonic(phrase)); // 64 bytes
	return bytesToHex(seed.slice(0, 32)); // 32 bytes -> 64 hex chars
}
