/**
 * Keyed mutex: serializes async work per key while different keys proceed
 * independently. In-process only (single-server assumption). Callers own their
 * registry so each lock family (git ops, container lifecycle, credentials, ...)
 * has its own key space and its own documented scope.
 *
 * The queue is explicit rather than a promise chain because a bounded wait needs
 * one. Chaining `previous.then(() => next)` gives a waiter no way to leave: an
 * acquirer that gives up abandons a promise nobody will ever resolve, and every
 * later acquirer waits on it forever. A waiter that times out or aborts here is
 * removed from the queue and holds nothing.
 */

/**
 * What a lock family may label a holder with: a bare string, or a record with a
 * label plus whatever else a waiter wants to know about who is ahead of it.
 */
export type LockOwner = string | { label: string };

/** The human-readable half of an owner, for messages. */
export function lockOwnerLabel(owner: LockOwner | null): string | null {
	if (owner === null) return null;
	return typeof owner === 'string' ? owner : owner.label;
}

/** Raised when an acquire gives up on its own deadline. */
export class KeyedLockTimeoutError extends Error {
	constructor(key: string, timeoutMs: number, owner: LockOwner | null) {
		const label = lockOwnerLabel(owner);
		super(
			`timed out after ${timeoutMs}ms waiting for the '${key}' lock` +
				`${label ? `, held by ${label}` : ''}`,
		);
		this.name = 'KeyedLockTimeoutError';
	}
}

interface Waiter<Owner extends LockOwner> {
	/** Hand the lock over. Null once this waiter has settled either way. */
	grant: ((owner: Owner | null) => void) | null;
	owner: Owner | null;
	priority: boolean;
}

interface LockState<Owner extends LockOwner> {
	/** What is holding the lock, for diagnostics. Null when unlabelled. */
	owner: Owner | null;
	queue: Waiter<Owner>[];
}

/**
 * A lock family's key space. Held by the caller, never module-global, so the
 * scope of each family stays visible where it is declared. The owner type is the
 * family's: most label a holder with a string, one that wants a waiter to be able
 * to point at the holder carries a record.
 */
export type KeyedLockRegistry<Owner extends LockOwner = string> = Map<string, LockState<Owner>>;

export interface AcquireOptions<Owner extends LockOwner = string> {
	/** Gives up when this fires, rejecting with the signal's own reason. */
	signal?: AbortSignal;
	/** Gives up after this long, rejecting with {@link KeyedLockTimeoutError}. */
	timeoutMs?: number;
	/** Labels the holder so a waiter can say what it is waiting on. */
	owner?: Owner;
	/**
	 * Queue ahead of every waiter that did not ask for this, behind those that
	 * did. Never preempts the holder. The one departure from arrival order, and
	 * it is for a waiter a person is sitting behind: the plain waiters it passes
	 * hold nothing and give up on their own deadline, so the cost of the jump is
	 * a later start for work nobody is watching.
	 */
	priority?: boolean;
}

/** What currently holds the key, or null when the key is free or unlabelled. */
export function currentOwner<Owner extends LockOwner>(
	registry: KeyedLockRegistry<Owner>,
	key: string,
): Owner | null {
	return registry.get(key)?.owner ?? null;
}

/**
 * Take the lock, resolving to the function that gives it back.
 *
 * Registration is synchronous - the state is created or the waiter enqueued
 * before this returns its promise - so acquires issued in one synchronous run
 * are served in that order, priority waiters ahead of the rest.
 *
 * The returned release is idempotent, since it is called from a `finally` that
 * may itself be reached more than one way.
 */
export function acquireKeyedLock<Owner extends LockOwner = string>(
	registry: KeyedLockRegistry<Owner>,
	key: string,
	opts: AcquireOptions<Owner> = {},
): Promise<() => void> {
	const owner = opts.owner ?? null;
	const existing = registry.get(key);

	if (!existing) {
		registry.set(key, { owner, queue: [] });
		return Promise.resolve(makeRelease(registry, key));
	}

	return new Promise<() => void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waiter: Waiter<Owner> = {
			owner,
			priority: opts.priority === true,
			grant: (nextOwner) => {
				settle();
				const state = registry.get(key);
				if (state) state.owner = nextOwner;
				resolve(makeRelease(registry, key));
			},
		};

		/** Stops this waiter answering to anything else, whichever way it ended. */
		const settle = () => {
			waiter.grant = null;
			if (timer !== undefined) clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
		};

		const giveUp = (error: unknown) => {
			if (!waiter.grant) return;
			settle();
			// Leaving the queue is the whole point: a waiter that gave up must not
			// keep a slot the holder would later hand the lock to.
			const state = registry.get(key);
			if (state) {
				const at = state.queue.indexOf(waiter);
				if (at >= 0) state.queue.splice(at, 1);
			}
			reject(error);
		};

		const onAbort = () => giveUp(opts.signal?.reason);

		if (opts.signal?.aborted) {
			settle();
			reject(opts.signal.reason);
			return;
		}
		opts.signal?.addEventListener('abort', onAbort, { once: true });

		if (opts.timeoutMs !== undefined) {
			const timeoutMs = opts.timeoutMs;
			timer = setTimeout(
				() => giveUp(new KeyedLockTimeoutError(key, timeoutMs, currentOwner(registry, key))),
				timeoutMs,
			);
		}

		if (waiter.priority) {
			// Behind the priority waiters already queued, ahead of everyone else.
			const at = existing.queue.findIndex((w) => !w.priority);
			if (at < 0) existing.queue.push(waiter);
			else existing.queue.splice(at, 0, waiter);
		} else {
			existing.queue.push(waiter);
		}
	});
}

/**
 * Hand the lock to the next waiter, or drop the key when nobody wants it.
 *
 * Waiters that gave up are already out of the queue, so the head is always a
 * live one; the loop guards the case of a waiter settled between shift and call.
 */
function makeRelease<Owner extends LockOwner>(
	registry: KeyedLockRegistry<Owner>,
	key: string,
): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const state = registry.get(key);
		if (!state) return;
		for (;;) {
			const next = state.queue.shift();
			if (!next) {
				registry.delete(key);
				return;
			}
			const grant = next.grant;
			if (grant) {
				grant(next.owner);
				return;
			}
		}
	};
}

/**
 * Run `fn` holding the lock, releasing it however `fn` settles.
 *
 * A rejection propagates to this caller alone - the queue moves on regardless,
 * so one failure never poisons the key.
 */
export async function withKeyedLock<T, Owner extends LockOwner = string>(
	registry: KeyedLockRegistry<Owner>,
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const release = await acquireKeyedLock(registry, key);
	try {
		return await fn();
	} finally {
		release();
	}
}
