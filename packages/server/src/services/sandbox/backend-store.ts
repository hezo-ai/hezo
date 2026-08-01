/**
 * Where the operator's container-backend choice is kept, and how it is opened.
 *
 * The backend used to be pure startup configuration - a flag, read once. It is
 * now a **setting**, so the stored value is authoritative and the flag only
 * seeds it. That ordering is the whole point: an operator who switches to
 * Daytona from the Containers page and then restarts must come back on Daytona,
 * not on whatever the launch command happened to say. The flag still matters on
 * a fresh instance, which has nothing stored yet.
 *
 * The provider credential lives in the **secrets vault**, encrypted with the
 * master key, and is decrypted in-process by this module alone. It is Hezo's own
 * credential for reaching the provider's control plane - it never enters an
 * agent container, and is not the kind of secret the egress proxy substitutes.
 */

import { isSandboxBackend, SandboxBackend } from '@hezo/shared';
import { decrypt, encrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { getSystemMeta, setSystemMeta } from '../../lib/system-meta';

export const SANDBOX_BACKEND_KEY = 'sandbox_backend';
export const DAYTONA_API_URL_KEY = 'sandbox_daytona_api_url';

/** Vault row holding the Daytona control-plane API key. */
export const DAYTONA_API_KEY_SECRET = 'HEZO_DAYTONA_API_KEY';

/**
 * The backend the operator has selected, or null when they never have.
 *
 * Null is meaningfully different from `docker`: it means "no choice recorded",
 * which is what lets the CLI flag seed a fresh instance without ever overriding
 * a deliberate later switch back to Docker.
 */
export async function getStoredSandboxBackend(db: Db): Promise<SandboxBackend | null> {
	const raw = await getSystemMeta(db, SANDBOX_BACKEND_KEY);
	if (!raw) return null;
	return isSandboxBackend(raw) ? raw : null;
}

export async function setStoredSandboxBackend(db: Db, backend: SandboxBackend): Promise<void> {
	await setSystemMeta(db, SANDBOX_BACKEND_KEY, backend);
}

export async function getStoredDaytonaApiUrl(db: Db): Promise<string | null> {
	return getSystemMeta(db, DAYTONA_API_URL_KEY);
}

export async function setStoredDaytonaApiUrl(db: Db, url: string | null): Promise<void> {
	await setSystemMeta(db, DAYTONA_API_URL_KEY, url ?? '');
}

/**
 * Store (or rotate) the provider API key in the vault.
 *
 * `allowed_hosts` is empty and substitution is off deliberately: those fields
 * govern the egress proxy's placeholder substitution for **agent** traffic, and
 * this key is never handed to an agent. Marking it substitutable would make it
 * reachable from inside a run, which is the red line.
 */
export async function storeDaytonaApiKey(
	db: Db,
	masterKeyManager: MasterKeyManager,
	apiKey: string,
): Promise<void> {
	const key = masterKeyManager.getKey();
	// Locked instance: the vault cannot be written without the master key, and
	// saying so is better than storing something that will not decrypt.
	if (!key) throw new Error('the instance is locked; unlock it before saving a provider key');
	await db.query(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts, allow_body_substitution)
		 VALUES ($1, $2, 'api_token', $3, false, false)
		 ON CONFLICT (name) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = now()`,
		[DAYTONA_API_KEY_SECRET, encrypt(apiKey, key), []],
	);
}

/** The stored provider API key, or null when none has been saved. */
export async function readDaytonaApiKey(
	db: Db,
	masterKeyManager: MasterKeyManager,
): Promise<string | null> {
	const res = await db.query<{ encrypted_value: string }>(
		`SELECT encrypted_value FROM secrets WHERE name = $1`,
		[DAYTONA_API_KEY_SECRET],
	);
	const row = res.rows[0];
	if (!row) return null;
	const key = masterKeyManager.getKey();
	if (!key) return null;
	try {
		return decrypt(row.encrypted_value, key);
	} catch {
		// A key that cannot be decrypted is not a key. Answering null makes the
		// caller report "no credential configured", which is the actionable
		// message; a throw here would surface as an opaque failure much later.
		return null;
	}
}

/** Whether a provider credential is on file, without decrypting or returning it. */
export async function hasDaytonaApiKey(db: Db): Promise<boolean> {
	const res = await db.query(`SELECT 1 FROM secrets WHERE name = $1`, [DAYTONA_API_KEY_SECRET]);
	return res.rows.length > 0;
}

/**
 * Resolve which backend to open at startup, and with what.
 *
 * Precedence, in order: the stored setting, then the launch flag, then Docker.
 * The flag is written through to storage when it seeds, so the choice a fresh
 * instance boots with is visible on the Containers page rather than being
 * invisible state that only the launch command knows about.
 */
export async function resolveStartupBackend(
	db: Db,
	masterKeyManager: MasterKeyManager,
	flags: { backend?: string; daytonaApiKey?: string; daytonaApiUrl?: string },
): Promise<{ backend: SandboxBackend; daytonaApiKey?: string; daytonaApiUrl?: string }> {
	const stored = await getStoredSandboxBackend(db);

	// A key or URL supplied at launch is stored so a later switch does not have to
	// ask for it again - the operator already provided it once.
	if (flags.daytonaApiKey) await storeDaytonaApiKey(db, masterKeyManager, flags.daytonaApiKey);
	if (flags.daytonaApiUrl) await setStoredDaytonaApiUrl(db, flags.daytonaApiUrl);

	if (stored) {
		return {
			backend: stored,
			daytonaApiKey:
				(await readDaytonaApiKey(db, masterKeyManager)) ?? flags.daytonaApiKey ?? undefined,
			daytonaApiUrl: (await getStoredDaytonaApiUrl(db)) || flags.daytonaApiUrl || undefined,
		};
	}

	const seeded =
		flags.backend && isSandboxBackend(flags.backend.trim().toLowerCase())
			? (flags.backend.trim().toLowerCase() as SandboxBackend)
			: SandboxBackend.Docker;
	await setStoredSandboxBackend(db, seeded);
	return {
		backend: seeded,
		daytonaApiKey:
			flags.daytonaApiKey ?? (await readDaytonaApiKey(db, masterKeyManager)) ?? undefined,
		daytonaApiUrl: flags.daytonaApiUrl ?? (await getStoredDaytonaApiUrl(db)) ?? undefined,
	};
}
