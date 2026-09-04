import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxBackend } from '@hezo/shared';
import { Logger } from '@hiddentao/logger';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetRuntimeConfig, setRuntimeConfig } from '../src/config/runtime';
import { DEFAULT_CONFIG } from '../src/config/types';
import { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { DockerClient } from '../src/services/docker';
import {
	completeSandboxBackendOnUnlock,
	hasDaytonaApiKey,
	readDaytonaApiKey,
	resolveStartupBackend,
	setStoredSandboxBackend,
	storeDaytonaApiKey,
} from '../src/services/sandbox/backend-store';
import { DaytonaClient } from '../src/services/sandbox/daytona/client';
import { DaytonaEngine } from '../src/services/sandbox/daytona/engine';
import { SandboxBackendError } from '../src/services/sandbox/errors';
import { SandboxBackendHolder } from '../src/services/sandbox/holder';
import { createPendingEngine, pendingUnlockMessage } from '../src/services/sandbox/pending';
import { describeSwitchImpact, switchSandboxBackend } from '../src/services/sandbox/switch-backend';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp } from './helpers/app';

/**
 * The property under test is a new process with no unlock input. New processes
 * start locked by default; a supervised update can restore the key through its
 * in-memory IPC handoff, and deliberate one-shot `--master-key` or
 * `HEZO_MASTER_KEY` input can inject it at startup. This fixture exercises none
 * of those inputs, so the operator unlocks from the browser afterwards.
 *
 * In that locked-default path, the vault was unusable at the moment the backend
 * was chosen, and both directions were fatal - reading a stored provider key
 * failed as "no API key is configured" for a key plainly on file, and writing a
 * launch-supplied one threw outright. The process therefore exited before a
 * browser unlock. A supervised in-memory update handoff or deliberate one-shot
 * `--master-key` / `HEZO_MASTER_KEY` input starts unlocked and bypasses this path.
 *
 * So these assert that neither direction is fatal any more, and - just as
 * important - that the genuine misconfiguration still is.
 */

let db: Db;
const dataDir = mkdtempSync(join(tmpdir(), 'hezo-backend-store-'));
let unlocked: MasterKeyManager;
/** Enrolled state with no startup key or supervisor handoff. */
const locked = new MasterKeyManager();

/**
 * The switch below opens a real `DockerClient`, whose host preparation probes
 * bind mounts by booting a throwaway container. On a machine that has a daemon
 * that is a real container per run of this file, for a property none of these
 * assert. Documented opt-out rather than a mock, so the rest of the preparation
 * still runs.
 */

beforeAll(async () => {
	setRuntimeConfig({
		...DEFAULT_CONFIG,
		containers: { ...DEFAULT_CONFIG.containers, skipMountCheck: true },
	});
	const ctx = await createTestApp();
	db = ctx.db;
	unlocked = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
	resetRuntimeConfig();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await db.query(`DELETE FROM secrets WHERE name = 'HEZO_DAYTONA_API_KEY'`);
	await db.query(
		`DELETE FROM system_meta WHERE key IN ('sandbox_backend', 'sandbox_daytona_api_url')`,
	);
});

function daytonaAnswers(): void {
	vi.spyOn(DaytonaClient.prototype, 'ping').mockResolvedValue(true);
}

/**
 * Record warnings from every logger, not from a freshly built child.
 *
 * `logger.child(...)` returns a new instance per call, so spying on one made
 * here never touches the module-level logger the code under test captured at
 * import. Patching the prototype does, which is the same reason `logger.ts`
 * patches `shouldSkipLevel` there rather than on an instance.
 */
function captureWarnings(): () => string[] {
	const seen: string[] = [];
	vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
		seen.push(args.map(String).join(' '));
	});
	return () => seen;
}

describe('resolveStartupBackend on a locked instance', () => {
	it('carries a launch-supplied key through instead of refusing to boot', async () => {
		// The exact combination that broke: the operator has a Daytona key in
		// their launch env and unlocks from the browser. The vault write cannot
		// happen yet, but the key is in hand, so the backend opens normally.
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);

		const resolved = await resolveStartupBackend(db, locked, { daytonaApiKey: 'dtn_from_flag' });

		expect(resolved.backend).toBe(SandboxBackend.Daytona);
		expect(resolved.daytonaApiKey).toBe('dtn_from_flag');
		// Nothing to wait for - we have the credential, so the preflight runs at boot.
		expect(resolved.deferred).toBe(false);
		// And the write really was skipped rather than half-done.
		expect(await hasDaytonaApiKey(db)).toBe(false);
	});

	it('defers when the key is on file but only the vault has it', async () => {
		await storeDaytonaApiKey(db, unlocked, 'dtn_stored');
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);

		const resolved = await resolveStartupBackend(db, locked, {});

		expect(resolved.deferred).toBe(true);
		// Deferring is not guessing: no key is invented for the boot to run on.
		expect(resolved.daytonaApiKey).toBeUndefined();
		expect(resolved.backend).toBe(SandboxBackend.Daytona);
	});

	it('does not defer a genuine misconfiguration, so the boot still fails', async () => {
		// A provider selected with no credential anywhere will never work, whatever
		// happens at unlock. Deferring it would trade a clear boot error for an
		// instance that looks healthy until the first agent run.
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);

		const resolved = await resolveStartupBackend(db, locked, {});

		expect(resolved.deferred).toBe(false);
		expect(resolved.daytonaApiKey).toBeUndefined();
	});

	it('never defers Docker, which needs no credential', async () => {
		await setStoredSandboxBackend(db, SandboxBackend.Docker);
		const resolved = await resolveStartupBackend(db, locked, {});
		expect(resolved).toMatchObject({ backend: SandboxBackend.Docker, deferred: false });
	});

	it('says so when a provider key is supplied but no provider is selected', async () => {
		// The trap that reads as "I set up Daytona and it ran on Docker anyway":
		// the key is a credential, not a selection, and nothing said so.
		const warnings = captureWarnings();
		const resolved = await resolveStartupBackend(db, unlocked, { daytonaApiKey: 'dtn_x' });

		expect(resolved.backend).toBe(SandboxBackend.Docker);
		expect(warnings().join(' ')).toMatch(/containers\.backend: "daytona"/);
	});

	it('says so when the launch flag disagrees with the stored setting', async () => {
		// Stored wins by design, so this changes nothing - but an operator who
		// typed a backend and got another one should not have to infer that.
		await setStoredSandboxBackend(db, SandboxBackend.Docker);
		const warnings = captureWarnings();

		const resolved = await resolveStartupBackend(db, unlocked, { backend: 'daytona' });

		expect(resolved.backend).toBe(SandboxBackend.Docker);
		expect(warnings().join(' ')).toMatch(/stored setting wins/);
	});

	it('stays quiet when the flag agrees with what is stored', async () => {
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);
		await storeDaytonaApiKey(db, unlocked, 'dtn_x');
		const warnings = captureWarnings();

		await resolveStartupBackend(db, unlocked, { backend: 'daytona', daytonaApiKey: 'dtn_x' });

		// Scoped to this module's two warnings rather than "nothing warned at all",
		// which any unrelated background line would break.
		expect(warnings().filter((w) => /sandbox-backend|containers\.backend/i.test(w))).toEqual([]);
	});

	it('still writes the key through when the instance is already unlocked', async () => {
		// The unlocked path is unchanged - this is the regression guard for it.
		await resolveStartupBackend(db, unlocked, {
			backend: 'daytona',
			daytonaApiKey: 'dtn_seeded',
		});
		expect(await readDaytonaApiKey(db, unlocked)).toBe('dtn_seeded');
	});
});

describe('completeSandboxBackendOnUnlock', () => {
	function pendingHolder(): SandboxBackendHolder {
		return new SandboxBackendHolder({
			engine: createPendingEngine(pendingUnlockMessage('https://app.daytona.io/api')),
			info: { backend: SandboxBackend.Daytona, display: 'https://app.daytona.io/api' },
			dataDir,
		});
	}

	it('opens the deferred backend and points the holder at it', async () => {
		daytonaAnswers();
		await storeDaytonaApiKey(db, unlocked, 'dtn_stored');
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);
		const resolved = await resolveStartupBackend(db, locked, {});
		expect(resolved.deferred).toBe(true);

		const holder = pendingHolder();
		// The handle every consumer captured at wiring time, taken before the swap.
		const captured = holder.engine;
		await completeSandboxBackendOnUnlock(db, unlocked, holder, resolved);

		// The captured reference now drives a real engine - that is what makes the
		// deferral invisible to the job manager, the chat manager and the HQ warm-up.
		await expect(captured.ping()).resolves.toBe(true);
		expect(holder.backend).toBe(SandboxBackend.Daytona);
	});

	it('prepares the host of the engine it swapped in', async () => {
		// Startup could not: it held the pending engine, which has no host and
		// throws from every member, so asking it there exited the boot instead.
		// Preparation therefore has to happen here or nowhere - and "nowhere" is
		// invisible, since a backend that never extracted its build context or
		// probed its mounts fails much later and reads as a broken agent run.
		daytonaAnswers();
		await storeDaytonaApiKey(db, unlocked, 'dtn_stored');
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);
		const resolved = await resolveStartupBackend(db, locked, {});

		const prepared: string[] = [];
		const holder = pendingHolder();
		vi.spyOn(DaytonaEngine.prototype, 'prepareHost').mockImplementation(async ({ dataDir: d }) => {
			prepared.push(d);
		});

		await completeSandboxBackendOnUnlock(db, unlocked, holder, resolved);

		expect(prepared).toEqual([dataDir]);
	});

	it('leaves the pending engine in place when the deferred open fails', async () => {
		// The no-silent-fallback rule at its most tempting: we are long past
		// startup and cannot exit, so the wrong move is to carry on with Docker.
		vi.spyOn(DaytonaClient.prototype, 'ping').mockResolvedValue(false);
		await storeDaytonaApiKey(db, unlocked, 'dtn_stored');
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);
		const resolved = await resolveStartupBackend(db, locked, {});

		const holder = pendingHolder();
		await expect(
			completeSandboxBackendOnUnlock(db, unlocked, holder, resolved),
		).rejects.toBeInstanceOf(SandboxBackendError);

		expect(holder.backend).toBe(SandboxBackend.Daytona);
		expect(() => holder.engine.ping()).toThrow(SandboxBackendError);
	}, 20_000);

	it('persists a launch-supplied key that could not be written at boot', async () => {
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);
		const resolved = await resolveStartupBackend(db, locked, { daytonaApiKey: 'dtn_from_flag' });
		expect(await hasDaytonaApiKey(db)).toBe(false);

		const holder = new SandboxBackendHolder({
			engine: createStubDocker(),
			info: { backend: SandboxBackend.Daytona, display: 'https://app.daytona.io/api' },
			dataDir,
		});
		await completeSandboxBackendOnUnlock(db, unlocked, holder, resolved);

		// So the Containers page shows a credential on file, and the next restart
		// works without the flag.
		expect(await readDaytonaApiKey(db, unlocked)).toBe('dtn_from_flag');
	});

	it('does not rewrite a key that has not changed', async () => {
		// This runs on every unlock, and under MVCC an unconditional UPDATE would
		// leave a dead tuple per boot on an embedded database with no autovacuum.
		await storeDaytonaApiKey(db, unlocked, 'dtn_same');
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);
		const resolved = await resolveStartupBackend(db, unlocked, { daytonaApiKey: 'dtn_same' });

		const writes: string[] = [];
		const query = db.query.bind(db);
		vi.spyOn(db, 'query').mockImplementation((sql: string, params?: unknown[]) => {
			if (/INSERT INTO secrets/i.test(sql)) writes.push(sql);
			return query(sql, params);
		});

		const holder = new SandboxBackendHolder({
			engine: createStubDocker(),
			info: { backend: SandboxBackend.Daytona, display: 'https://app.daytona.io/api' },
			dataDir,
		});
		await completeSandboxBackendOnUnlock(db, unlocked, holder, resolved);

		expect(writes).toEqual([]);
	});
});

describe('recovering from a stored key that no longer works', () => {
	/**
	 * The end-to-end trap, which only closes if every step holds: an operator
	 * whose stored Daytona key has expired must still be able to boot, reach the
	 * Containers page, and switch back to Docker.
	 *
	 * Each step used to break on its own. The boot aborted (fixed by deferring);
	 * then the deferred open failed and left a pending engine that threw
	 * *synchronously*, which `.catch()` does not catch - so listing containers
	 * took out both the page that shows the switch and the switch itself.
	 */
	it('boots, renders the switch impact, and switches to Docker', async () => {
		vi.spyOn(DaytonaClient.prototype, 'ping').mockResolvedValue(false);
		vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(true);
		await storeDaytonaApiKey(db, unlocked, 'dtn_expired');
		await setStoredSandboxBackend(db, SandboxBackend.Daytona);

		// 1. Boot is not fatal - the key is on file, just unreadable while locked.
		const resolved = await resolveStartupBackend(db, locked, {});
		expect(resolved.deferred).toBe(true);

		const holder = new SandboxBackendHolder({
			engine: createPendingEngine(pendingUnlockMessage('https://app.daytona.io/api')),
			info: { backend: SandboxBackend.Daytona, display: 'https://app.daytona.io/api' },
			dataDir,
		});

		// 2. Unlock connects for real, and the expired key is refused.
		await expect(
			completeSandboxBackendOnUnlock(db, unlocked, holder, resolved),
		).rejects.toBeInstanceOf(SandboxBackendError);

		// 3. The Containers page still renders: this is what the switch dialog's
		//    numbers come from, and it runs against the pending engine.
		await expect(describeSwitchImpact(db, holder.engine, dataDir)).resolves.toMatchObject({
			containers: 0,
		});

		// 4. And the switch away actually completes.
		const result = await switchSandboxBackend(
			db,
			unlocked,
			holder,
			{ backend: SandboxBackend.Docker },
			async () => null,
			dataDir,
		);
		expect(result.backend).toBe(SandboxBackend.Docker);
		expect(holder.backend).toBe(SandboxBackend.Docker);
		await expect(holder.engine.ping()).resolves.toBe(true);
	}, 20_000);
});

describe('the pending engine', () => {
	it('names the unlock as the thing to do, on every operation', () => {
		const engine = createPendingEngine(pendingUnlockMessage('https://app.daytona.io/api'));
		// Not a TypeError on an undefined method - a named error saying what to do.
		expect(() => engine.ping()).toThrow(SandboxBackendError);
		expect(() => engine.listContainersByLabel('hezo.instance')).toThrow(/instance is locked/);
		expect(() => engine.ping()).toThrow(/Unlock the instance/);
	});

	it('stays inert under incidental inspection', async () => {
		// A runtime probing the value - awaiting it, logging it - must not surface
		// as a backend error pointing at the wrong thing.
		const engine = createPendingEngine('nope');
		await expect(Promise.resolve(engine)).resolves.toBeDefined();
		expect(() => String(engine)).not.toThrow();
	});
});
