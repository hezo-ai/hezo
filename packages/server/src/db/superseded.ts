import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Helpers for the pre-migration snapshots the copy-migrate-swap leaves behind.
 *
 * On every embedded-DB migration the runner renames the old cluster aside to
 * `pgdata.superseded.<timestamp>` (`migrate-swap.ts`) so a failed upgrade can be
 * rolled back. Those directories accumulate; the swap auto-retains the newest
 * `KEEP_SUPERSEDED`, and the General-settings "Prune" control lets a superuser
 * reclaim them all on demand. Both paths share the logic here.
 */

/** Prefix for a previous `pgdata`, kept aside after a successful migration swap. */
export const SUPERSEDED_PREFIX = 'pgdata.superseded.';

/**
 * List the `pgdata.superseded.<timestamp>` directories in `dataDir` as full
 * paths, sorted oldest-first (the timestamp format sorts chronologically). A
 * missing or unreadable data dir yields an empty list.
 */
export async function listSupersededDirs(dataDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(dataDir);
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.startsWith(SUPERSEDED_PREFIX))
		.sort()
		.map((e) => join(dataDir, e));
}

/** Recursively sum the on-disk size, in bytes, of everything under `dir`. */
async function dirSize(dir: string): Promise<number> {
	// A missing/unreadable dir contributes nothing (e.g. raced with a delete).
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	let total = 0;
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await dirSize(full);
		} else {
			try {
				total += (await stat(full)).size;
			} catch {
				// Raced with a concurrent delete (e.g. a migration swap) — skip it.
			}
		}
	}
	return total;
}

export interface SupersededUsage {
	/** Number of superseded snapshot directories. */
	count: number;
	/** Total on-disk size of those directories, in bytes. */
	bytes: number;
}

/** Count the superseded snapshot directories and their total on-disk size. */
export async function measureSuperseded(dataDir: string): Promise<SupersededUsage> {
	const dirs = await listSupersededDirs(dataDir);
	let bytes = 0;
	for (const dir of dirs) bytes += await dirSize(dir);
	return { count: dirs.length, bytes };
}

export interface SupersededPruneResult {
	/** Number of snapshot directories removed. */
	removed: number;
	/** Total on-disk bytes freed. */
	bytes: number;
}

/**
 * Remove superseded snapshot directories, keeping the `keep` newest. `keep = 0`
 * (the default) removes them all — the on-demand "reclaim everything" path;
 * the migration swap passes `KEEP_SUPERSEDED` to preserve its rollback window.
 * Returns how many directories were removed and the bytes freed.
 */
export async function pruneSuperseded(dataDir: string, keep = 0): Promise<SupersededPruneResult> {
	const dirs = await listSupersededDirs(dataDir); // oldest-first
	const victims = keep > 0 ? dirs.slice(0, Math.max(0, dirs.length - keep)) : dirs;
	let bytes = 0;
	for (const dir of victims) {
		bytes += await dirSize(dir);
		await rm(dir, { recursive: true, force: true });
	}
	return { removed: victims.length, bytes };
}
