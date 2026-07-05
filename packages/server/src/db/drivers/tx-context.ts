import { AsyncLocalStorage } from 'node:async_hooks';
import type { Queryable } from '../database';

interface TxStore {
	tx: Queryable;
	closed: boolean;
}

/**
 * Async-context transaction pinning shared by both drivers. While a
 * `Db.transaction(cb)` block runs, every `query`/`exec` issued from the
 * block's async context — including closed-over calls on the owning `Db` —
 * must land on the transaction's pinned connection, never the shared handle
 * or pool. AsyncLocalStorage provides that routing without threading a
 * transaction handle through every call site, which also makes it impossible
 * for a query inside the block to accidentally escape the transaction.
 *
 * Per-driver-instance on purpose: tests hold several live databases in one
 * worker process, and a module-level store would cross-route between them.
 */
export class TxContext {
	private readonly als = new AsyncLocalStorage<TxStore>();

	/**
	 * The pinned queryable when called from inside a live transaction block,
	 * else null. Throws when called from async work that outlived its block —
	 * a silent fallback would run the query outside the transaction on the
	 * postgres driver (or inside somebody else's on PGlite).
	 */
	current(): Queryable | null {
		const store = this.als.getStore();
		if (!store) return null;
		if (store.closed) {
			throw new Error(
				'Query issued after its enclosing transaction completed — ' +
					'await all database work inside the transaction block',
			);
		}
		return store.tx;
	}

	async run<T>(tx: Queryable, fn: () => Promise<T>): Promise<T> {
		const store: TxStore = { tx, closed: false };
		try {
			return await this.als.run(store, fn);
		} finally {
			store.closed = true;
		}
	}
}
