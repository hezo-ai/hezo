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
 * ended, so a lingering (or mis-accounted) connection can park the returned
 * promise forever and wedge whatever awaits it. Force-destroys remaining
 * connections where the runtime supports it and resolves after the deadline
 * regardless, so callers on a run-completion path can never hang on teardown.
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
			if (timedOut) {
				log.warn(`server close timed out after ${deadlineMs}ms; abandoning wait`, { label });
			}
			resolve();
		};
		const timer = setTimeout(() => finish(true), deadlineMs);
		server.close(() => finish(false));
		// http/https servers can sever remaining keep-alive and hijacked
		// connections immediately; net servers expose no equivalent, so their
		// callers destroy tracked sockets before closing.
		(server as Partial<HttpServer>).closeAllConnections?.();
	});
}
