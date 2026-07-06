import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MasterKeyManager } from '../src/crypto/master-key';
import {
	createSupervisorUnlockKeyStore,
	type IpcEndpoint,
	isUnlockKeyMessage,
	isUnlockKeyRequest,
	setupWorkerUnlockHandoff,
	unlockKeyMessage,
	unlockKeyRequest,
} from '../src/lib/unlock-handoff';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

// The IPC handoff that lets an update restart come back unlocked: the worker
// pushes its unlock key to the supervisor at unlock time, the supervisor holds
// it in memory, and the relaunched worker asks for it back on a locked boot.
// The real bun↔bun IPC transport is pinned in test/bun/unlock-handoff.bun.test.ts;
// this file covers the protocol and both process halves against a real
// MasterKeyManager + database.

describe('unlock-handoff message guards', () => {
	it('accepts messages built by the helpers', () => {
		expect(isUnlockKeyMessage(unlockKeyMessage('ab'.repeat(32)))).toBe(true);
		expect(isUnlockKeyRequest(unlockKeyRequest())).toBe(true);
	});

	it('rejects junk and near-misses', () => {
		expect(isUnlockKeyMessage(null)).toBe(false);
		expect(isUnlockKeyMessage('hezo:unlock-key')).toBe(false);
		expect(isUnlockKeyMessage({ type: 'hezo:unlock-key' })).toBe(false); // key missing
		expect(isUnlockKeyMessage({ type: 'hezo:unlock-key', unlockKeyHex: 42 })).toBe(false);
		expect(isUnlockKeyMessage(unlockKeyRequest())).toBe(false);
		expect(isUnlockKeyRequest(null)).toBe(false);
		expect(isUnlockKeyRequest({ type: 'other' })).toBe(false);
		expect(isUnlockKeyRequest(unlockKeyMessage('ab'.repeat(32)))).toBe(false);
	});
});

describe('supervisor unlock-key store', () => {
	it('does not reply to a request before any key was pushed (first boot)', () => {
		const store = createSupervisorUnlockKeyStore();
		const replies: unknown[] = [];
		store.handleMessage(unlockKeyRequest(), (m) => replies.push(m));
		expect(replies).toHaveLength(0);
	});

	it('replies to a request with the last pushed key', () => {
		const store = createSupervisorUnlockKeyStore();
		const replies: Array<{ unlockKeyHex: string }> = [];
		store.handleMessage(unlockKeyMessage('aa'.repeat(32)), () => {});
		store.handleMessage(unlockKeyMessage('bb'.repeat(32)), () => {}); // newer push wins
		store.handleMessage(unlockKeyRequest(), (m) => replies.push(m));
		expect(replies).toHaveLength(1);
		expect(replies[0].unlockKeyHex).toBe('bb'.repeat(32));
	});

	it('ignores unrelated messages', () => {
		const store = createSupervisorUnlockKeyStore();
		const replies: unknown[] = [];
		store.handleMessage({ type: 'something-else' }, (m) => replies.push(m));
		store.handleMessage(unlockKeyRequest(), (m) => replies.push(m));
		expect(replies).toHaveLength(0);
	});
});

describe('worker unlock handoff', () => {
	let ctx: Awaited<ReturnType<typeof createTestApp>>;
	let validKey: string;

	beforeAll(async () => {
		ctx = await createTestApp();
		validKey = ctx.masterKeyManager.getUnlockKeyHex() as string;
	});
	afterAll(() => safeClose(ctx.db));

	/** A locked manager against the test db (whose canary the ctx key opens). */
	async function lockedManager(): Promise<MasterKeyManager> {
		const mkm = new MasterKeyManager();
		expect(await mkm.initialize(ctx.db)).toBe('locked');
		return mkm;
	}

	function fakeEndpoint(withSend = true) {
		const sent: unknown[] = [];
		let listener: ((m: unknown) => void) | null = null;
		const endpoint: IpcEndpoint = {
			send: withSend ? (m: unknown) => sent.push(m) : undefined,
			on: (_event, cb) => {
				listener = cb;
			},
		};
		return {
			endpoint,
			sent,
			deliver: (m: unknown) => listener?.(m),
			hasListener: () => !!listener,
		};
	}

	it('no-ops without an IPC channel (dev / plain binary)', async () => {
		const mkm = await lockedManager();
		const { endpoint, hasListener } = fakeEndpoint(false);
		setupWorkerUnlockHandoff({ db: ctx.db, masterKeyManager: mkm }, endpoint);
		expect(hasListener()).toBe(false);
		expect(mkm.getState()).toBe('locked');
	});

	it('pushes the key immediately when booted already unlocked, without requesting', () => {
		const { endpoint, sent } = fakeEndpoint();
		// ctx.masterKeyManager is unlocked (createTestApp enrolls + unlocks).
		setupWorkerUnlockHandoff({ db: ctx.db, masterKeyManager: ctx.masterKeyManager }, endpoint);
		expect(sent.some((m) => isUnlockKeyMessage(m) && m.unlockKeyHex === validKey)).toBe(true);
		expect(sent.some((m) => isUnlockKeyRequest(m))).toBe(false);
	});

	it('on a locked boot: requests the key, unlocks with the reply, then pushes it back up', async () => {
		const mkm = await lockedManager();
		const { endpoint, sent, deliver } = fakeEndpoint();
		setupWorkerUnlockHandoff({ db: ctx.db, masterKeyManager: mkm }, endpoint);

		expect(sent.some((m) => isUnlockKeyRequest(m))).toBe(true);

		deliver(unlockKeyMessage(validKey));
		await vi.waitFor(() => expect(mkm.getState()).toBe('unlocked'));
		// The onUnlock hook re-pushed the key so the supervisor stays current.
		expect(sent.some((m) => isUnlockKeyMessage(m) && m.unlockKeyHex === validKey)).toBe(true);
	});

	it('stays locked on a stale supervisor key (canary check fails harmlessly)', async () => {
		const mkm = await lockedManager();
		const { endpoint, deliver } = fakeEndpoint();
		setupWorkerUnlockHandoff({ db: ctx.db, masterKeyManager: mkm }, endpoint);

		deliver(unlockKeyMessage('00'.repeat(32)));
		await new Promise((r) => setTimeout(r, 50));
		expect(mkm.getState()).toBe('locked');

		// A later valid delivery (e.g. the operator unlocking from the gate would
		// go through unlock() the same way) still works.
		deliver(unlockKeyMessage(validKey));
		await vi.waitFor(() => expect(mkm.getState()).toBe('unlocked'));
	});

	it('full restart cycle: worker push → supervisor store → relaunched worker unlock', async () => {
		const store = createSupervisorUnlockKeyStore();

		// First worker: unlocked, pushes its key up; supervisor stores it.
		const first = fakeEndpoint();
		setupWorkerUnlockHandoff(
			{ db: ctx.db, masterKeyManager: ctx.masterKeyManager },
			first.endpoint,
		);
		for (const m of first.sent) store.handleMessage(m, () => {});

		// "Update restart": a fresh, locked worker asks the supervisor for the key.
		const mkm = await lockedManager();
		const second = fakeEndpoint();
		setupWorkerUnlockHandoff({ db: ctx.db, masterKeyManager: mkm }, second.endpoint);
		for (const m of second.sent) store.handleMessage(m, (reply) => second.deliver(reply));

		await vi.waitFor(() => expect(mkm.getState()).toBe('unlocked'));
	});
});
