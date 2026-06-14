/**
 * The e2e master key phrase (the canonical all-"abandon" BIP39 vector).
 * Shared by playwright.config.ts (boot-enrolls the shared server via
 * HEZO_MASTER_KEY) and helpers.ts (derives the keypair + unlock key for the
 * challenge-response login dance).
 */
export const TEST_MNEMONIC =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
