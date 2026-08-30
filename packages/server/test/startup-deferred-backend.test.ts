import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAuthKeyPair, deriveUnlockKey, SandboxBackend } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { setStoredSandboxBackend, storeDaytonaApiKey } from '../src/services/sandbox/backend-store';
import { DaytonaClient } from '../src/services/sandbox/daytona/client';
import { SandboxBackendError } from '../src/services/sandbox/errors';
import { getRunSocketDir } from '../src/services/workspace';
import { type StartupResult, startup } from '../src/startup';
import { testHezoConfig } from './helpers/config';

/**
 * A new process with no unlock input starts locked by default, with the provider
 * key readable only from the vault. This fixture exercises that path. A
 * supervised update can restore the key through its in-memory handoff, and
 * deliberate one-shot `--master-key` or `HEZO_MASTER_KEY` input can inject it at
 * startup; those unlocked paths bypass the pending engine exercised here.
 *
 * `resolveStartupBackend` defers the open in exactly that case and `startup()`
 * holds the pending engine until browser unlock, which keeps this locked-default
 * process reachable. The trap is that the pending engine throws from every
 * member by design, so any boot-time call against it exits the process -
 * `index.ts` classifies `SandboxBackendError` as a fatal, unreachable backend,
 * which a healthy locked instance is not. That is precisely what an unconditional
 * `prepareHost` at the end of backend setup did: the boot printed "unlock the
 * instance to finish connecting" and then died, and `dev.ts` killed the web
 * server behind it. Supervised in-memory handoff and deliberate one-shot
 * `--master-key` / `HEZO_MASTER_KEY` input start unlocked and never take this path.
 *
 * Runs with `HEZO_SKIP_DOCKER` **unset**, deliberately: the skip branch bypasses
 * `resolveStartupBackend` entirely and would assert nothing about the deferral.
 */

const PHRASE =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('startup with a vault-backed container backend', () => {
	let dataDir: string;
	let result: StartupResult | null = null;
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		for (const key of ['HEZO_SKIP_DOCKER', 'HEZO_SKIP_PRICING_REFRESH']) {
			savedEnv[key] = process.env[key];
		}
		process.env.HEZO_SKIP_PRICING_REFRESH = '1';
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-deferred-backend-'));
	});

	afterAll(async () => {
		await shutdown();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(getRunSocketDir(dataDir), { recursive: true, force: true });
	});

	async function shutdown(): Promise<void> {
		if (!result) return;
		result.jobManager.shutdown();
		await result.chatSessionManager.stop();
		await waitForBackground();
		await result.db.close().catch(() => undefined);
		result = null;
	}

	it('boots locked and holds the pending engine instead of exiting', async () => {
		// Nothing here may reach the provider: the whole property is that a
		// deferred boot never opens the backend. A ping that did arrive fails the
		// test rather than silently succeeding against the network.
		const daytonaPing = vi
			.spyOn(DaytonaClient.prototype, 'ping')
			.mockRejectedValue(new Error('the deferred boot must not contact the provider'));

		// Seed the state an operator ends up in: a provider key in the vault and
		// the backend switched to it. Written through a boot rather than a bare
		// database because the vault needs an unlocked master key - and on the fake
		// engine, because this boot is only here to fill the vault. The boot under
		// test is the second one, which reaches no container backend at all.
		process.env.HEZO_SKIP_DOCKER = '1';
		result = await startup(
			testHezoConfig(dataDir, {
				masterKey: {
					unlockKeyHex: deriveUnlockKey(PHRASE),
					publicKeyHex: deriveAuthKeyPair(PHRASE).publicKeyHex,
				},
			}),
		);
		expect(result.masterKeyState).toBe('unlocked');
		await storeDaytonaApiKey(result.db, result.masterKeyManager, 'dtn_stored');
		await setStoredSandboxBackend(result.db, SandboxBackend.Daytona);
		// The unlock fans out reconciliation and the HQ warm-up in the background.
		// Tearing down before they have started closes the database under them,
		// which surfaces as `PGlite is closed` errors in an otherwise green run.
		const jm = result.jobManager as unknown as { started: boolean };
		await vi.waitFor(() => expect(jm.started).toBe(true), { timeout: 30_000 });
		await shutdown();

		// The restart: enrolled database, no master key in hand. This resolving at
		// all is the regression - it used to reject with SandboxBackendError.
		delete process.env.HEZO_SKIP_DOCKER;
		result = await startup(testHezoConfig(dataDir));

		expect(result.masterKeyState).toBe('locked');
		expect(daytonaPing).not.toHaveBeenCalled();
		// And the backend really is deferred rather than quietly opened, or quietly
		// fallen back to Docker: the engine every consumer holds is the pending one,
		// which names the unlock from every member and throws *synchronously*.
		expect(() => result?.docker.ping()).toThrow(SandboxBackendError);
		expect(() => result?.docker.ping()).toThrow(/Unlock the instance/);
	}, 120_000);
});
