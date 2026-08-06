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

import { isSandboxBackend, SandboxBackend, sandboxBackendNeedsApiKey } from '@hezo/shared';
import { decrypt, encrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { getSystemMeta, setSystemMeta } from '../../lib/system-meta';
import { logger } from '../../logger';
import type { SandboxBackendHolder } from './holder';
import { openSandboxBackend } from './open';

const log = logger.child('sandbox-backend');

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

export interface StartupBackendResolution {
	backend: SandboxBackend;
	daytonaApiKey?: string;
	daytonaApiUrl?: string;
	/**
	 * The backend needs a credential that only the encrypted vault holds, and the
	 * vault is locked - so it cannot be opened yet, but it is not misconfigured
	 * either. The caller holds a pending engine and finishes the open on unlock
	 * (see {@link completeSandboxBackendOnUnlock}).
	 */
	deferred: boolean;
}

/**
 * Resolve which backend to open at startup, and with what.
 *
 * Precedence, in order: the stored setting, then the launch flag, then Docker.
 * The flag is written through to storage when it seeds, so the choice a fresh
 * instance boots with is visible on the Containers page rather than being
 * invisible state that only the launch command knows about.
 *
 * **Nothing here is fatal because the instance is locked.** An instance comes
 * back locked after every restart by design, so a rule that needed the vault at
 * this point would fire on every single boot: reading a stored provider key
 * would fail ("no API key is configured", for a key that is plainly on file),
 * and writing a flag-supplied one would fail outright ("the instance is
 * locked"). Between them they made `HEZO_DAYTONA_API_KEY` unusable in exactly
 * the setup that needs it - an operator who put it in their launch env and
 * unlocks from the browser. So the vault write is opportunistic and the vault
 * read is allowed to defer; both are completed on unlock.
 */
export async function resolveStartupBackend(
	db: Db,
	masterKeyManager: MasterKeyManager,
	flags: { backend?: string; daytonaApiKey?: string; daytonaApiUrl?: string },
): Promise<StartupBackendResolution> {
	const stored = await getStoredSandboxBackend(db);

	// A key or URL supplied at launch is stored so a later switch does not have to
	// ask for it again - the operator already provided it once. The vault needs
	// the master key, so when the instance is still locked this write waits for
	// the unlock rather than failing the boot.
	if (flags.daytonaApiKey && masterKeyManager.getKey()) {
		await storeDaytonaApiKey(db, masterKeyManager, flags.daytonaApiKey);
	}
	if (flags.daytonaApiUrl) await setStoredDaytonaApiUrl(db, flags.daytonaApiUrl);

	const requested = flags.backend?.trim().toLowerCase();
	const backend =
		stored ??
		(requested && isSandboxBackend(requested)
			? (requested as SandboxBackend)
			: SandboxBackend.Docker);
	if (!stored) await setStoredSandboxBackend(db, backend);

	// Two ways a launch command can mean less than it appears to, both of which
	// were silent - the operator read the Containers page, saw a backend they did
	// not ask for, and had nothing to connect it to.
	if (requested && stored && requested !== stored) {
		log.warn(
			`Ignoring --sandbox-backend / HEZO_SANDBOX_BACKEND=${requested}: this instance is set to ` +
				`${stored}, and the stored setting wins so a stale launch script cannot undo a switch ` +
				'made from the Containers page. Change it in Settings -> Containers.',
		);
	}
	if (!requested && flags.daytonaApiKey && !sandboxBackendNeedsApiKey(backend)) {
		// A provider credential is not a provider selection: pre-seeding a key for
		// a later switch is a real use, so this is a warning rather than an
		// inference about what the operator meant.
		log.warn(
			'HEZO_DAYTONA_API_KEY is set but containers run on local Docker. The key selects no ' +
				'backend on its own - add --sandbox-backend daytona / HEZO_SANDBOX_BACKEND=daytona to ' +
				'run on Daytona, or switch from Settings -> Containers. The key is saved either way.',
		);
	}

	// The flag wins over the vault, and did before: the write above lands first,
	// so a stored read returned the flag's own value anyway. Stating it once
	// removes an asymmetry between the two branches that never meant anything,
	// and makes rotating by flag work while locked.
	const daytonaApiKey =
		flags.daytonaApiKey ?? (await readDaytonaApiKey(db, masterKeyManager)) ?? undefined;
	const daytonaApiUrl = flags.daytonaApiUrl || (await getStoredDaytonaApiUrl(db)) || undefined;

	// A key we cannot read is not the same as a key that is not there. `has` asks
	// without decrypting, which is what separates "wait for the unlock" from the
	// genuine misconfiguration of selecting a provider and never giving it a
	// credential - that one still fails the boot, because it will never work.
	const deferred =
		sandboxBackendNeedsApiKey(backend) &&
		!daytonaApiKey &&
		!masterKeyManager.getKey() &&
		(await hasDaytonaApiKey(db));

	return { backend, daytonaApiKey, daytonaApiUrl, deferred };
}

/**
 * Finish the boot-time backend decision once the vault is readable.
 *
 * Two things wait for the unlock, and both are here so the caller has one hook
 * rather than two: a launch-supplied key that could not be written, and a
 * deferred open whose credential could not be read.
 *
 * Nothing is lost by waiting. Every consumer of the engine already starts on
 * this same unlock, because a locked instance cannot run an agent whichever
 * backend it is on.
 *
 * **This is not a fallback.** A deferred open that fails leaves the pending
 * engine in place, so every container operation reports that failure instead of
 * quietly succeeding on some other backend.
 */
export async function completeSandboxBackendOnUnlock(
	db: Db,
	masterKeyManager: MasterKeyManager,
	holder: SandboxBackendHolder,
	startup: StartupBackendResolution,
): Promise<void> {
	// Persist the launch-supplied key now that the vault accepts writes, so the
	// Containers page shows a credential on file and the next restart needs no
	// flag. Guarded on a real change: this runs on every unlock, and an
	// unconditional UPDATE would leave a dead tuple per boot under MVCC.
	if (startup.daytonaApiKey) {
		const current = await readDaytonaApiKey(db, masterKeyManager);
		if (current !== startup.daytonaApiKey) {
			await storeDaytonaApiKey(db, masterKeyManager, startup.daytonaApiKey);
		}
	}

	if (!startup.deferred) return;

	const opened = await openSandboxBackend({
		backend: startup.backend,
		daytonaApiKey: (await readDaytonaApiKey(db, masterKeyManager)) ?? undefined,
		daytonaApiUrl: (await getStoredDaytonaApiUrl(db)) || startup.daytonaApiUrl || undefined,
	});
	// The swap prepares the incoming engine's host too, which is the half startup
	// could not do: it held the pending engine, which has no host to prepare.
	await holder.swap(opened);
}
