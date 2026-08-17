import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Server as NetServer } from 'node:net';
import { logger } from '../logger';

const log = logger.child('net');

const DEFAULT_CLOSE_DEADLINE_MS = 5_000;

type CloseableServer = HttpServer | HttpsServer | NetServer;

/**
 * Merge abort signals, ignoring the absent ones.
 *
 * The shape to reach for whenever a call has both a caller-owned cancel and a
 * bound of its own. Picking one over the other silently drops the other's
 * guarantee - a caller signal that *replaces* a timeout leaves the call with no
 * upper bound at all, which is how a single wedged request can park a run
 * indefinitely.
 */
export function combineAbortSignals(
	...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
	const present = signals.filter((s): s is AbortSignal => s !== undefined);
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	return AbortSignal.any(present);
}

const DEFAULT_LISTEN_DEADLINE_MS = 10_000;

/** Raised when a bind neither succeeds nor errors inside its deadline. */
export class ListenTimeoutError extends Error {
	constructor(label: string, deadlineMs: number) {
		super(`${label} did not finish binding within ${deadlineMs}ms`);
		this.name = 'ListenTimeoutError';
	}
}

/**
 * Bind a server with a hard upper bound, the counterpart to
 * {@link closeServerWithDeadline}.
 *
 * `listen()` settles on its callback or an `error` event, and a bind that does
 * neither - a wedged filesystem under an AF_UNIX path, a stalled runtime - hangs
 * the caller with nothing to time it out. On the run path that call sits inside
 * the window holding a container and the provider credential, so an unbounded
 * bind is an unbounded wedge. The server is closed on expiry so the attempt
 * leaves no half-bound handle behind.
 */
export function listenWithDeadline(
	server: CloseableServer,
	label: string,
	listen: (onListening: () => void) => void,
	deadlineMs: number = DEFAULT_LISTEN_DEADLINE_MS,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			server.removeListener('error', onError);
			if (!error) return resolve();
			// Swallowed, not ignored: closing a server that never bound answers
			// ERR_SERVER_NOT_RUNNING, and with no callback it raises that as an
			// unhandled `error` event on the way out of a path that is already
			// reporting a failure of its own.
			server.close(() => {});
			reject(error);
		};
		const onError = (e: Error) => finish(e);
		const timer = setTimeout(() => finish(new ListenTimeoutError(label, deadlineMs)), deadlineMs);
		server.once('error', onError);
		listen(() => finish());
	});
}

/**
 * Close a server with a hard upper bound on how long the close can take.
 * `server.close()`'s callback only fires once every accepted connection has
 * ended — and under Bun `closeAllConnections()` does not sever a live accepted
 * https connection, so the callback can park the returned promise for the whole
 * deadline on every teardown that carried a long-lived stream. Resolution is
 * therefore gated on the listening handle releasing (which the runtime does
 * promptly even when the drain callback never fires), so the port is free to
 * reuse the moment we return. The deadline only warns if the handle is still
 * bound — a genuine wedge, not a mis-accounted connection. Callers severing
 * their own tracked sockets before closing makes those connections end too;
 * this is the backstop for any that escape that tracking.
 */
export function closeServerWithDeadline(
	server: CloseableServer,
	label: string,
	deadlineMs: number = DEFAULT_CLOSE_DEADLINE_MS,
): Promise<void> {
	return new Promise<void>((resolve) => {
		let settled = false;
		const finish = (timedOut: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(poll);
			if (timedOut) {
				log.warn(`server still listening ${deadlineMs}ms after close; abandoning wait`, { label });
			}
			resolve();
		};
		const timer = setTimeout(() => finish(true), deadlineMs);
		// The listening handle frees promptly even when the drain callback is
		// mis-accounted and never fires; resolve on that rather than the callback.
		// Created before close() so a synchronous close callback never hits a
		// not-yet-assigned `poll`.
		const poll = setInterval(() => {
			if (!server.listening) finish(false);
		}, 25);
		server.close(() => finish(false));
		// http/https servers can sever remaining keep-alive and hijacked
		// connections immediately; net servers expose no equivalent, so their
		// callers destroy tracked sockets before closing.
		(server as Partial<HttpServer>).closeAllConnections?.();
	});
}
