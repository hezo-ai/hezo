/**
 * Moving committed work between a container and the bundle vault.
 *
 * The vault (`bundle-vault.ts`) knows about storage and knows nothing about git;
 * `git.ts` knows how to build and consume a bundle and knows nothing about where
 * it is kept. This is the seam between them, and it is the only place that holds
 * both halves - so the storage layout and the git invocation can each change
 * without the other learning about it.
 *
 * Both directions are **best-effort and non-throwing**. Saving happens at run
 * finalize, where the run is already being failed for the unpushed work; throwing
 * there would replace a precise error with a stack trace. Restoring happens in run
 * prep, where a failure means this run starts without an earlier container's
 * commits - bad, worth reporting, and still better than refusing to run.
 */

import { logger } from '../../logger';
import {
	createRecoveryBundle,
	fetchRecoveryBundle,
	RECOVERY_BUNDLE_REL_PATH,
	type RepoLoc,
} from '../git';
import type { GitExecutor } from '../git-executor';
import { type BundleKey, type BundleVault, checkBundleSize } from './bundle-vault';
import type { SandboxFiles } from './files';

const log = logger.child('git-recovery');

/**
 * What a save or restore attempt did, in the words the run log uses.
 *
 * `bytes: null` on success means there was nothing to do - no stored bundle to
 * restore - which is distinct from having moved an empty one.
 */
export type RecoveryOutcome = { ok: true; bytes: number | null } | { ok: false; reason: string };

/**
 * Copy a branch's undelivered commits out of a container and into the vault.
 *
 * The order matters and is the whole design: **build on the container's local
 * disk, then move the finished file**. `git bundle create` seeks while writing, so
 * writing it anywhere but real local disk dies with `pack-objects died`; and the
 * size is checked before the bytes are read, because reading buffers all of them.
 *
 * A success here is what lets the pool release its pin on the container - the
 * commits are no longer only in one place - so a failure must be loud rather than
 * silently leaving a container that looks free but is not.
 */
export async function saveRecoveryBundle(
	vault: BundleVault,
	files: SandboxFiles,
	executor: GitExecutor,
	repo: RepoLoc,
	key: BundleKey,
): Promise<RecoveryOutcome> {
	const built = await createRecoveryBundle(executor, repo, key.branch).catch((e: unknown) => ({
		ok: false as const,
		error: (e as Error).message,
	}));
	if (!built.ok) return { ok: false, reason: `could not pack the commits: ${built.error}` };

	try {
		const bytes = await files.size(RECOVERY_BUNDLE_REL_PATH);
		if (bytes === null) return { ok: false, reason: 'the bundle was not written' };
		const sized = checkBundleSize(bytes);
		if (!sized.ok) return { ok: false, reason: sized.reason };

		await vault.put(key, await files.readBytes(RECOVERY_BUNDLE_REL_PATH));
		return { ok: true, bytes };
	} catch (e) {
		return { ok: false, reason: `could not copy the bundle out: ${(e as Error).message}` };
	} finally {
		// The clone keeps no copy: it is the container being emptied, and a stale
		// bundle in its git dir would be restored over a newer one on the next run.
		await files.remove(RECOVERY_BUNDLE_REL_PATH).catch(() => undefined);
	}
}

/**
 * Put a stored bundle into a container and fetch its commits into the clone.
 *
 * Called during run prep **after** the origin fetch: the bundle is a delta whose
 * prerequisites are the remote tips, so a clone that has not caught up with origin
 * cannot apply it. `git bundle` checks that itself and refuses rather than
 * half-applying, so the ordering is enforced by git, not just by this comment.
 *
 * `{ ok: true, bytes: null }` means there was nothing stored, which is the
 * overwhelmingly common case and not worth a log line.
 */
export async function restoreRecoveryBundle(
	vault: BundleVault,
	files: SandboxFiles,
	executor: GitExecutor,
	repo: RepoLoc,
	key: BundleKey,
): Promise<RecoveryOutcome> {
	let contents: Uint8Array | null;
	try {
		contents = await vault.get(key);
	} catch (e) {
		return { ok: false, reason: `could not read the stored bundle: ${(e as Error).message}` };
	}
	if (contents === null) return { ok: true, bytes: null };

	try {
		await files.writeBytes(RECOVERY_BUNDLE_REL_PATH, contents, { mode: 0o600 });
	} catch (e) {
		return { ok: false, reason: `could not place the bundle: ${(e as Error).message}` };
	}

	try {
		const fetched = await fetchRecoveryBundle(executor, repo);
		if (!fetched.ok) return { ok: false, reason: `could not apply the bundle: ${fetched.error}` };
		return { ok: true, bytes: contents.byteLength };
	} finally {
		await files.remove(RECOVERY_BUNDLE_REL_PATH).catch(() => undefined);
	}
}

/**
 * Drop a stored bundle whose commits demonstrably reached the remote.
 *
 * The one condition under which the vault discards anything, and the reason it is
 * not a deletion of the user's data: by the time this runs, `origin` has the
 * commits. Best-effort - a bundle that cannot be dropped is a stale copy of safe
 * work, never a failure worth surfacing to a run.
 */
export async function releaseRecoveryBundle(vault: BundleVault, key: BundleKey): Promise<void> {
	try {
		if (await vault.has(key)) {
			await vault.remove(key);
			log.info(`recovery: dropped the stored bundle for ${key.repoName}@${key.branch} — pushed`);
		}
	} catch (e) {
		log.warn(`recovery: could not drop the stored bundle: ${(e as Error).message}`);
	}
}
