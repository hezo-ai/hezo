/**
 * Where committed work goes when it could not reach the user's git host.
 *
 * ## The failure this exists for
 *
 * A project used to have exactly one container, so a denied push was survivable:
 * the next run hit the same `.git` and the ref was still there. With a pool it is
 * not. Run 1 commits into container A, the push is denied, run 2 lands on
 * container B and fetches from a remote that never received the commit, and A is
 * destroyed when it goes idle. **Nothing fails at pool size 1**, which is why no
 * existing test caught it.
 *
 * Three things answer that, and this is the third. The run is failed
 * (`findUnpushedWork`), the container is pinned against destroy for that clone and
 * branch (`recordStrandedWork`), and the commits are copied out of it to here - so
 * the pin can be released and a *different* container can pick the work up.
 *
 * ## Why a bundle, and why on the instance
 *
 * A git bundle is one finished file: the only shape an object store supports, and
 * the only shape that needs no rename, no in-place append and no chmod. It cannot
 * be a bare repo on shared storage - `git init --bare` fails there outright
 * (`unable to write symref for HEAD`), because git needs atomic rename for refs.
 *
 * The bundles live under the instance's own data dir rather than on a provider
 * volume, and the transport is `SandboxFiles` - the seam that already exists for
 * exactly this ("written by the container, read back by the host") and that both
 * backends already implement. So the vault is **backend-agnostic**: no volume
 * mount, no provider file plumbing, and nothing per-adapter to keep in step. It
 * also puts the recovery copy where the operator's backups already are, which a
 * provider volume would not.
 *
 * ## Bound and invalidation
 *
 * Bounded by {@link MAX_RECOVERY_BUNDLE_BYTES} per bundle, checked **before** the
 * bytes are read, because the read buffers the whole file. An oversized bundle is
 * refused rather than trimmed, and the container stays pinned - the copy is what
 * makes the pin releasable, so no copy means no release.
 *
 * Invalidated by success: a bundle is removed once a later run finds that branch
 * carries no unpushed commits, i.e. the work reached `origin` after all. That is
 * not deleting the user's data - the data is on their remote by then, which is the
 * only condition under which this drops anything. It is otherwise kept
 * indefinitely, and cleared wholesale only when its project is deleted.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Largest bundle the vault will accept, in bytes.
 *
 * A normal task's delta is kilobytes: the bundle carries only commits no durable
 * remote has. 64 MiB is far above that and is sized by what may be held in memory
 * rather than by what git could produce - `SandboxFiles.readBytes` buffers the
 * whole file, and the reference workload is ~10 concurrent runs in one process.
 *
 * A bundle this large means the clone had no remote to exclude against, so it is
 * a copy of the history rather than of the run's work. Refusing it (and saying so)
 * beats quietly moving hundreds of megabytes per failed push through the API
 * process.
 */
export const MAX_RECOVERY_BUNDLE_BYTES = 64 * 1024 * 1024;

/** Directory under the data dir holding every project's recovery bundles. */
export const RECOVERY_VAULT_DIRNAME = 'git-recovery';

/**
 * One stored bundle's identity: the project, the repo within it, and the branch.
 *
 * The repo is named rather than keyed by id because the id is not in hand where
 * the scan produces its findings, and a repo *name* is already unique within a
 * project - it is the directory name under `/workspace`.
 */
export interface BundleKey {
	projectId: string;
	repoName: string;
	branch: string;
}

/**
 * A filesystem-safe filename for a key.
 *
 * A branch is `hezo/<TASK-12>`, so it carries a slash, and a repo name is
 * whatever the user's git host allows. Both are slugged for readability and then
 * disambiguated by a hash of the exact original, so two keys that slug alike
 * cannot collide onto one bundle - which would hand a run another branch's
 * commits.
 */
export function bundleFileName(key: BundleKey): string {
	const slug = `${key.repoName}-${key.branch}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
	const digest = createHash('sha256')
		.update(`${key.repoName}\u0000${key.branch}`)
		.digest('hex')
		.slice(0, 12);
	return `${slug}-${digest}.bundle`;
}

/**
 * Recovery bundles held for later runs to pick up.
 *
 * Whole files only, deliberately: `put`/`get`/`has`/`remove` and nothing that
 * would let a caller append to, rename or chmod a stored object. The local
 * filesystem behind it could do all three; not exposing them is what keeps this
 * implementable on an object store later without any caller changing.
 */
export interface BundleVault {
	/** Store (replacing) the bundle for a key. */
	put(key: BundleKey, contents: Uint8Array): Promise<void>;
	/** The stored bundle, or null when there is none. */
	get(key: BundleKey): Promise<Uint8Array | null>;
	has(key: BundleKey): Promise<boolean>;
	/** Best-effort delete. A missing bundle is not an error. */
	remove(key: BundleKey): Promise<void>;
	/** Drop every bundle for a project, for teardown. */
	removeProject(projectId: string): Promise<void>;
}

/** {@link BundleVault} rooted at `<dataDir>/git-recovery`. */
export function createBundleVault(dataDir: string): BundleVault {
	const projectDir = (projectId: string) => join(dataDir, RECOVERY_VAULT_DIRNAME, projectId);
	const pathOf = (key: BundleKey) => join(projectDir(key.projectId), bundleFileName(key));

	return {
		put: async (key, contents) => {
			const dir = projectDir(key.projectId);
			mkdirSync(dir, { recursive: true });
			// 0o600: a recovery bundle is the user's source code, and the data dir is
			// read by the server process alone.
			writeFileSync(pathOf(key), contents, { mode: 0o600 });
		},
		get: async (key) => {
			const path = pathOf(key);
			if (!existsSync(path)) return null;
			return new Uint8Array(readFileSync(path));
		},
		has: async (key) => existsSync(pathOf(key)),
		remove: async (key) => {
			try {
				rmSync(pathOf(key), { force: true });
			} catch {
				// Best-effort by contract - a bundle that cannot be dropped is a stale
				// copy of work that is already safely on the remote, not a failure.
			}
		},
		removeProject: async (projectId) => {
			try {
				rmSync(projectDir(projectId), { recursive: true, force: true });
			} catch {
				// Same: teardown must not fail over leftover recovery copies.
			}
		},
	};
}

/**
 * Whether a built bundle is small enough to move, given its size on disk.
 *
 * Split out from the transfer so the decision is testable without a container and
 * so the reason a bundle was refused can be reported verbatim - a size check
 * whose failure reads as "recovery didn't happen" is how a pinned container
 * becomes a mystery.
 */
export function checkBundleSize(bytes: number): { ok: true } | { ok: false; reason: string } {
	if (bytes <= MAX_RECOVERY_BUNDLE_BYTES) return { ok: true };
	const mib = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`;
	return {
		ok: false,
		reason:
			`recovery bundle is ${mib(bytes)}, over the ${mib(MAX_RECOVERY_BUNDLE_BYTES)} limit — ` +
			`this usually means the clone has no remote to pack against, so the bundle is the ` +
			`whole history rather than this run's commits`,
	};
}
