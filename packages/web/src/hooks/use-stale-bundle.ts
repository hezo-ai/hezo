import { useEffect, useRef, useState } from 'react';
import { useUpdateStatus } from './use-update-check';

/**
 * True once the connected server reports a *different* running version than the
 * one first observed this session — i.e. the server was updated (self-update,
 * redeploy) while this tab stayed open, so the loaded web bundle is now older
 * than the server. A stale bundle can't understand data the newer server pushes
 * (e.g. a new comment/action kind renders as the graceful "needs a newer
 * version" fallback until reload), so the shell surfaces a refresh prompt.
 *
 * Detection tracks a *change* in the server's version across the session rather
 * than comparing against a build-time constant. The server version is refetched
 * on mount and, crucially, on every WebSocket reconnect (`useInvalidateOnReconnect`
 * invalidates all queries) — and a server restart is exactly what drops and
 * re-establishes the socket — so the new version is observed right after the
 * update lands. Tracking a change (not an absolute value) also means it can't
 * false-positive in dev: a stable dev server version never "changes" unless you
 * actually restart onto a new build, where reloading is the correct thing to do.
 *
 * Latches: once a change is seen it stays true until the page reloads.
 */
export function useServerVersionChanged(): boolean {
	const { data } = useUpdateStatus();
	const firstSeen = useRef<string | null>(null);
	const [changed, setChanged] = useState(false);

	const current = data?.current ?? null;
	useEffect(() => {
		if (!current) return;
		if (firstSeen.current === null) {
			firstSeen.current = current;
			return;
		}
		if (current !== firstSeen.current) setChanged(true);
	}, [current]);

	return changed;
}
