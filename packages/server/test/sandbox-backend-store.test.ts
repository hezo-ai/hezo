import { SandboxBackend } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	completeSandboxBackendOnUnlock,
	hasDaytonaApiKey,
	readDaytonaApiKey,
	resolveStartupBackend,
	setStoredSandboxBackend,
	storeDaytonaApiKey,
} from '../src/services/sandbox/backend-store';
import { DaytonaClient } from '../src/services/sandbox/daytona/client';
import { SandboxBackendError } from '../src/services/sandbox/errors';
import { SandboxBackendHolder } from '../src/services/sandbox/holder';
import { createPendingEngine, pendingUnlockMessage } from '../src/services/sandbox/pending';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp } from './helpers/app';

/**
 * The property under test is the boot of an instance that is **locked**, which
 * is every boot: the master key is memory-only, so a restart always comes back
 * locked and the operator unlocks from the browser afterwards.
 *
 * That made the vault unusable at the moment the backend was chosen, and both
 * directions were fatal - reading a stored provider key failed as "no API key
 * is configured" for a key plainly on file, and writing a launch-supplied one
 * threw outright. A managed backend could therefore not survive a restart
 * unless the master key was passed on the command line, which is the one thing
 * we never ask an operator to persist.
 *
 * So these assert that neither direction is fatal any more, and - just as
 * important - that the genuine misconfiguration still is.
 */

let db: Db;
let unlocked: MasterKeyManager;
/** State every boot starts in: enrolled, but no key in memory yet. */
const locked = new MasterKeyManager();

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	unlocked = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
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

describe('resolveStartupBackend on a locked instance', () => {
	it('carries a launch-supplied key through instead of refusing to boot', async () => {
		// The exact combination that broke: the operator has HEZO_DAYTONA_API_KEY in
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
		});
		await completeSandboxBackendOnUnlock(db, unlocked, holder, resolved);

		expect(writes).toEqual([]);
	});
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
