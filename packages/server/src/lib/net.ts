import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Server as NetServer } from 'node:net';
import { logger } from '../logger';

const log = logger.child('net');

const DEFAULT_CLOSE_DEADLINE_MS = 5_000;

type CloseableServer = HttpServer | HttpsServer | NetServer;

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
