/**
 * The e2e master key phrase (the canonical all-"abandon" BIP39 vector).
 * Shared by playwright.config.ts (boot-enrolls the shared server via
 * HEZO_MASTER_KEY) and helpers.ts (derives the keypair + unlock key for the
 * challenge-response login dance).
 */
export const TEST_MNEMONIC =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * The e2e admin password. The mnemonic only unlocks the instance now — a session
 * is minted only by the password — so helpers exchange the master-key setup token
 * for a session by enrolling this password's verifier.
 */
export const TEST_PASSWORD = 'e2e-admin-password';
