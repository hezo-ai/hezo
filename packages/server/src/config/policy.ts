/**
 * The policy file: settings fixed by whoever deployed this instance, reloadable
 * while the server runs.
 *
 * **Its own file, not a block in the main config, and that is the point.** A plan
 * change must not restart the server: a restart kills in-flight agent runs, and
 * under an hours meter that is billed container time thrown away. Re-reading the
 * *main* config is the wrong mechanism twice over - `resolveConfig()` re-reads
 * argv and env and re-runs `detectRemovedEnvVars`, which can legitimately throw
 * to refuse a start, and `loadConfigFile` goes through `createRequire`, so
 * CommonJS caches the module and a second `require` of the same path returns the
 * old object. This file is plain JSON, re-read from disk, and swaps one slice.
 *
 * **The writer renames into place.** `<file>.tmp` then `rename()` is atomic on
 * POSIX, so a watcher can never observe a half-written file. That write pattern
 * is also why the watch is on the containing directory rather than on the file
 * itself - see `watchPolicyFile`. A deployment that writes in place instead will
 * occasionally hand us a truncated read, which is why a bad parse keeps the last
 * good value rather than clearing the policy. Clearing would silently unpin
 * every limit the deployment is billing for.
 */

import type { FSWatcher } from 'node:fs';
import { readFileSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger';
import { setPolicy } from './runtime';
import { policySchema } from './schema';
import type { PolicyConfig } from './types';

const log = logger.child('policy');

/**
 * Read and validate the policy file.
 *
 * Returns `undefined` for "no file configured", and `null` for "a file that
 * could not be read or did not validate" - the caller distinguishes them
 * because at startup the second should be loud, while on reload it must leave
 * the previous value alone.
 */
export function readPolicyFile(path: string | undefined): PolicyConfig | null | undefined {
	if (!path) return undefined;
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		log.warn(`could not read the policy file at ${path}: ${(err as Error).message}`);
		return null;
	}
	try {
		return policySchema.parse(JSON.parse(raw)) as PolicyConfig;
	} catch (err) {
		log.warn(`the policy file at ${path} is not valid: ${(err as Error).message}`);
		return null;
	}
}

/** Startup read. A file that is configured but unreadable pins nothing rather than failing the boot. */
export function loadPolicy(path: string | undefined): PolicyConfig | null | undefined {
	const policy = readPolicyFile(path);
	if (policy) {
		log.info(
			`settings pinned by ${policy.managedBy}: ${Object.keys(policy.pinned).join(', ') || 'none'}`,
		);
	}
	return policy ?? undefined;
}

/**
 * Watch for a new policy file and swap the slice when one lands.
 *
 * **Watches the containing directory, not the file.** A watch on the file is
 * bound to that file's inode, and the atomic `rename()` the writer is told to
 * use replaces the *directory entry* while leaving the old inode untouched - so
 * a file watch never fires for the one write pattern this is built around. The
 * directory entry is what changes, so the directory is what is watched.
 *
 * **Every event in that directory reloads, and none is filtered by name.** The
 * name a rename reports is the runtime's business and not the same on both: Node
 * reports the destination, so a filter on it worked; Bun reports only the
 * *source*, so on the runtime this ships as a compiled binary a name filter
 * dropped every policy change a deployment ever made. Measured against Bun
 * 1.3.11 and Node side by side, ten renames each: with the filter, 10/10 and
 * 0/10; without it, 10/10 on both, each reload reading the value just written.
 *
 * Reloading on a neighbouring file's event costs one small JSON read behind the
 * debounce, and a read that fails or does not validate already keeps the last
 * good value - so the cost of being wrong in this direction is nothing, and in
 * the other it is a deployment whose limits never move.
 *
 * Coalesced on a short timer: one rename fires more than once, and a deployment
 * that writes then chmods fires more again. Re-reading four times is harmless
 * but logs four times, which reads as thrashing.
 */
const RELOAD_DEBOUNCE_MS = 150;

/**
 * How long to wait before watching again after the watch reported an error.
 *
 * Short, because the window is blind: nothing re-delivers an event that landed
 * while the watch was down. Long enough that a directory being churned cannot
 * spin this into a tight loop.
 */
const REWATCH_DELAY_MS = 100;

export function watchPolicyFile(path: string | undefined): { close: () => void } {
	if (!path) return { close: () => {} };

	const directory = dirname(path);
	let watcher: FSWatcher | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let rewatch: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	const reload = () => {
		const next = readPolicyFile(path);
		// `null` means the read or the parse failed. Keep what we have: a
		// deployment mid-write must not unpin the limits it bills for.
		if (next === null || next === undefined) return;
		setPolicy(next);
		log.info(
			`policy reloaded from ${path}: ${Object.keys(next.pinned).join(', ') || 'nothing pinned'}`,
		);
	};

	/**
	 * What a watch error is, and why it cannot simply be swallowed.
	 *
	 * **An `FSWatcher` is an `EventEmitter`, and one that emits `error` with no
	 * listener throws.** The `try` below covers only the synchronous `watch()`
	 * call, so an error arriving later was an uncaught exception in the server
	 * process - and the thing that produces one is the *documented* write
	 * pattern: a deployment writes `<file>.tmp` and renames it over the target,
	 * and the runtime can be told about the `.tmp` after it has already gone.
	 * Bun reports that as `ENOENT` against a path nobody asked to watch.
	 *
	 * **Re-armed rather than left closed.** The runtime closes a watcher that
	 * errored, so swallowing the error quietly would leave a server that had
	 * stopped noticing policy changes with nothing to say about it - which is the
	 * exact failure this whole file exists to prevent.
	 */
	const onError = (err: Error) => {
		log.warn(`the policy watch on ${directory} reported an error: ${err.message}`);
		watcher?.close();
		watcher = null;
		if (closed || rewatch) return;
		rewatch = setTimeout(() => {
			rewatch = null;
			if (closed) return;
			arm();
			// **Re-read, because the window was blind.** The write that killed the
			// watch is usually the very write we wanted: a rename moves its `.tmp`
			// away, the runtime reports the vanished entry as an error, and nothing
			// will ever re-deliver an event for a rename that already finished.
			// Re-arming alone would leave the watch healthy and the value stale.
			reload();
		}, REWATCH_DELAY_MS);
		// The server must not be held open by a retry nobody is waiting for.
		rewatch.unref?.();
	};

	const arm = () => {
		try {
			const handle = watch(directory, () => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(reload, RELOAD_DEBOUNCE_MS);
			});
			handle.on('error', onError);
			watcher = handle;
		} catch (err) {
			// A directory that does not exist yet is not an error: a deployment may
			// create it after the server is up. Nothing is pinned until it does.
			log.warn(`could not watch for a policy file at ${path}: ${(err as Error).message}`);
		}
	};

	arm();

	return {
		close: () => {
			closed = true;
			if (timer) clearTimeout(timer);
			if (rewatch) clearTimeout(rewatch);
			rewatch = null;
			watcher?.close();
			watcher = null;
		},
	};
}
