import { describe, expect, it } from 'vitest';
import {
	acquireKeyedLock,
	currentOwner,
	type KeyedLockRegistry,
	KeyedLockTimeoutError,
	withKeyedLock,
} from '../src/lib/keyed-lock';

const registry = (): KeyedLockRegistry => new Map();

/** Lets a test hold the lock and hand it back at a chosen moment. */
async function hold(reg: KeyedLockRegistry, key: string, owner?: string) {
	return acquireKeyedLock(reg, key, owner ? { owner } : {});
}

describe('withKeyedLock', () => {
	it('serialises work on the same key in the order it was requested', async () => {
		const reg = registry();
		const order: string[] = [];
		const step = (name: string) =>
			withKeyedLock(reg, 'k', async () => {
				order.push(`${name}-start`);
				await new Promise((r) => setTimeout(r, 5));
				order.push(`${name}-end`);
			});

		await Promise.all([step('a'), step('b'), step('c')]);

		expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
	});

	it('lets different keys proceed independently', async () => {
		const reg = registry();
		const release = await hold(reg, 'busy');
		let ranOther = false;

		await withKeyedLock(reg, 'other', async () => {
			ranOther = true;
		});

		expect(ranOther).toBe(true);
		release();
	});

	it('propagates a failure to its own caller without poisoning the key', async () => {
		const reg = registry();
		const failing = withKeyedLock(reg, 'k', async () => {
			throw new Error('boom');
		});
		const following = withKeyedLock(reg, 'k', async () => 'ok');

		await expect(failing).rejects.toThrow('boom');
		await expect(following).resolves.toBe('ok');
	});

	it('leaves no entry behind once the last holder is done', async () => {
		const reg = registry();
		await withKeyedLock(reg, 'k', async () => undefined);
		expect(reg.size).toBe(0);
	});
});

describe('acquireKeyedLock deadlines', () => {
	it('rejects a waiter that outlasts its timeout', async () => {
		const reg = registry();
		const release = await hold(reg, 'k', 'run-a');

		await expect(acquireKeyedLock(reg, 'k', { timeoutMs: 10 })).rejects.toBeInstanceOf(
			KeyedLockTimeoutError,
		);

		release();
	});

	it('names the holder in the timeout message', async () => {
		const reg = registry();
		const release = await hold(reg, 'k', 'run-a');

		await expect(acquireKeyedLock(reg, 'k', { timeoutMs: 10 })).rejects.toThrow(/held by run-a/);

		release();
	});

	// The defect a promise-chain lock has and this one must not: a waiter that
	// gave up leaves an unresolvable link behind, and every later acquirer waits
	// on it forever.
	it('does not poison the queue when a waiter times out', async () => {
		const reg = registry();
		const release = await hold(reg, 'k');

		const abandoned = acquireKeyedLock(reg, 'k', { timeoutMs: 10 });
		await expect(abandoned).rejects.toBeInstanceOf(KeyedLockTimeoutError);

		const next = acquireKeyedLock(reg, 'k', { timeoutMs: 1_000 });
		release();

		const releaseNext = await next;
		expect(typeof releaseNext).toBe('function');
		releaseNext();
		expect(reg.size).toBe(0);
	});

	it('skips a timed-out waiter when handing the lock on', async () => {
		const reg = registry();
		const release = await hold(reg, 'k');
		const order: string[] = [];

		const first = acquireKeyedLock(reg, 'k', { timeoutMs: 10 }).catch(() => {
			order.push('first-timed-out');
		});
		const second = acquireKeyedLock(reg, 'k', { timeoutMs: 1_000 }).then((r) => {
			order.push('second-acquired');
			r();
		});

		await first;
		release();
		await second;

		expect(order).toEqual(['first-timed-out', 'second-acquired']);
	});

	it('resolves normally when the holder releases inside the timeout', async () => {
		const reg = registry();
		const release = await hold(reg, 'k');
		const waiting = acquireKeyedLock(reg, 'k', { timeoutMs: 1_000 });

		release();
		const releaseWaiter = await waiting;
		releaseWaiter();

		expect(reg.size).toBe(0);
	});
});

describe('acquireKeyedLock aborts', () => {
	it('rejects with the signal reason when aborted while waiting', async () => {
		const reg = registry();
		const release = await hold(reg, 'k');
		const ac = new AbortController();

		const waiting = acquireKeyedLock(reg, 'k', { signal: ac.signal });
		ac.abort('run_timeout');

		await expect(waiting).rejects.toBe('run_timeout');
		release();
	});

	it('rejects immediately on an already-aborted signal', async () => {
		const reg = registry();
		const release = await hold(reg, 'k');
		const ac = new AbortController();
		ac.abort('gone');

		await expect(acquireKeyedLock(reg, 'k', { signal: ac.signal })).rejects.toBe('gone');
		release();
	});

	it('does not poison the queue when a waiter aborts', async () => {
		const reg = registry();
		const release = await hold(reg, 'k');
		const ac = new AbortController();

		const aborted = acquireKeyedLock(reg, 'k', { signal: ac.signal });
		ac.abort('gone');
		await expect(aborted).rejects.toBe('gone');

		const next = acquireKeyedLock(reg, 'k', { timeoutMs: 1_000 });
		release();
		(await next)();

		expect(reg.size).toBe(0);
	});

	it('ignores an abort that fires after the lock was granted', async () => {
		const reg = registry();
		const release = await hold(reg, 'k');
		const ac = new AbortController();

		const waiting = acquireKeyedLock(reg, 'k', { signal: ac.signal });
		release();
		const releaseWaiter = await waiting;

		ac.abort('too late');
		releaseWaiter();

		expect(reg.size).toBe(0);
	});
});

describe('lock bookkeeping', () => {
	it('reports the current owner and clears it once free', async () => {
		const reg = registry();
		expect(currentOwner(reg, 'k')).toBeNull();

		const release = await hold(reg, 'k', 'run-a');
		expect(currentOwner(reg, 'k')).toBe('run-a');

		const waiting = acquireKeyedLock(reg, 'k', { owner: 'run-b', timeoutMs: 1_000 });
		release();
		const releaseB = await waiting;
		expect(currentOwner(reg, 'k')).toBe('run-b');

		releaseB();
		expect(currentOwner(reg, 'k')).toBeNull();
	});

	it('ignores a repeated release', async () => {
		const reg = registry();
		const release = await hold(reg, 'k', 'run-a');
		release();
		release();

		const second = await hold(reg, 'k', 'run-b');
		expect(currentOwner(reg, 'k')).toBe('run-b');
		second();
		expect(reg.size).toBe(0);
	});
});

describe('priority waiters', () => {
	it('is granted before earlier plain waiters and after earlier priority waiters', async () => {
		const reg = registry();
		const release = await hold(reg, 'k', 'holder');
		const order: string[] = [];
		const wait = (owner: string, priority = false) =>
			acquireKeyedLock(reg, 'k', { owner, priority, timeoutMs: 1_000 }).then((rel) => {
				order.push(owner);
				rel();
			});
		const all = [wait('plain-1'), wait('plain-2'), wait('prio-1', true), wait('prio-2', true)];

		release();
		await Promise.all(all);
		expect(order).toEqual(['prio-1', 'prio-2', 'plain-1', 'plain-2']);
	});

	it('never preempts the holder', async () => {
		const reg = registry();
		const release = await hold(reg, 'k', 'holder');
		let granted = false;
		const waiting = acquireKeyedLock(reg, 'k', { priority: true, timeoutMs: 1_000 }).then((rel) => {
			granted = true;
			rel();
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(granted).toBe(false);
		expect(currentOwner(reg, 'k')).toBe('holder');
		release();
		await waiting;
		expect(granted).toBe(true);
	});

	it('leaves the queue cleanly when a priority waiter gives up', async () => {
		const reg = registry();
		const release = await hold(reg, 'k', 'holder');
		const gaveUp = acquireKeyedLock(reg, 'k', { priority: true, timeoutMs: 5 }).catch((e) => e);
		const plain = acquireKeyedLock(reg, 'k', { owner: 'plain', timeoutMs: 1_000 });
		expect(await gaveUp).toBeInstanceOf(KeyedLockTimeoutError);
		release();
		(await plain)();
		expect(reg.size).toBe(0);
	});
});

describe('structured owners', () => {
	interface Holder {
		label: string;
		runId: string;
	}

	it('reports the whole record to a waiter and its label in the timeout message', async () => {
		const reg: KeyedLockRegistry<Holder> = new Map();
		const holder = { label: 'growth-analyst/HM-336', runId: 'run-1' };
		const release = await acquireKeyedLock(reg, 'k', { owner: holder });
		expect(currentOwner(reg, 'k')).toEqual(holder);

		const err = await acquireKeyedLock(reg, 'k', { timeoutMs: 5 }).catch((e) => e);
		expect(err).toBeInstanceOf(KeyedLockTimeoutError);
		expect((err as Error).message).toContain('held by growth-analyst/HM-336');
		expect((err as Error).message).not.toContain('run-1');
		release();
	});
});
