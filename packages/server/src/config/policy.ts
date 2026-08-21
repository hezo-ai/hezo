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
 * POSIX, so a watcher can never observe a half-written file. A deployment that
 * writes in place instead will occasionally hand us a truncated read - which is
 * why a bad parse keeps the last good value rather than clearing the policy.
 * Clearing would silently unpin every limit the deployment is billing for.
 */

import type { FSWatcher } from 'node:fs';
import { readFileSync, watch } from 'node:fs';
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
 * Watch the policy file and swap the slice when it changes.
 *
 * Coalesced on a short timer: an atomic rename fires `rename` and can fire
 * `change` besides, and a deployment that writes then chmods fires twice more.
 * Re-reading four times is harmless but logs four times, which reads as
 * thrashing.
 *
 * Watches the file rather than its directory, which means a rename replaces the
 * inode and can end the watch. Re-arming on every event is what keeps it alive
 * across the atomic-rename case the writer is supposed to use.
 */
export function watchPolicyFile(path: string | undefined): { close: () => void } {
	if (!path) return { close: () => {} };

	let watcher: FSWatcher | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
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

	const arm = () => {
		if (closed) return;
		try {
			watcher?.close();
			watcher = watch(path, () => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					reload();
					// Re-arm after a rename swapped the inode out from under the watch.
					arm();
				}, 150);
			});
		} catch (err) {
			// A file that does not exist yet is not an error: a deployment may write
			// it after the server is up. Nothing is pinned until it does.
			log.warn(`could not watch the policy file at ${path}: ${(err as Error).message}`);
		}
	};

	arm();
	return {
		close: () => {
			closed = true;
			if (timer) clearTimeout(timer);
			watcher?.close();
			watcher = null;
		},
	};
}
