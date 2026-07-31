import {
	chmodSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Reading and writing a run's artifact files, without assuming where they live.
 *
 * Several things Hezo needs are written *by the container* and read back *by the
 * host*: Grok's `--debug-file`, Kimi Code's `wire.jsonl`, a rotated subscription
 * credential, the auto-push error log. Today that works only because the run's
 * directory is a bind mount, so a host `readFileSync` sees what the container
 * wrote. A container that is not on this machine has no such shared path, and
 * those read-backs are the part of the run loop that cannot work at all without
 * an abstraction - which is why this exists.
 *
 * **Paths are relative to a root**, never absolute, and never host paths. That
 * is the whole point: the Docker implementation resolves them under a host
 * directory, and a remote implementation resolves the same relative paths under
 * the container directory through the provider's file API. A caller that passes
 * an absolute host path has silently opted out of ever being switchable, so
 * {@link hostSandboxFiles} rejects paths that escape the root.
 *
 * Async because a remote file API cannot be anything else. The Docker
 * implementation is synchronous underneath and simply resolves immediately.
 */
export interface SandboxFiles {
	exists(relPath: string): Promise<boolean>;
	/** Contents as UTF-8. Rejects if the file is missing or unreadable. */
	read(relPath: string): Promise<string>;
	/** Best-effort delete. A missing file is not an error. */
	remove(relPath: string): Promise<void>;
	/**
	 * Relative paths of every file named `basename` under `relDir`, depth-bounded.
	 *
	 * Symlinks are never followed - that is what makes the depth cap a real bound
	 * rather than an approximate one, since a symlink loop would otherwise defeat
	 * it. An unreadable directory yields nothing rather than throwing, because
	 * every caller of this is a best-effort scrape.
	 */
	findByName(relDir: string, basename: string, maxDepth: number): Promise<string[]>;
	/**
	 * Write a whole file, creating its parent directories.
	 *
	 * **`mode` is part of the contract, not a detail.** These files carry
	 * credentials and are read by a *deprivileged* process inside the container,
	 * so two permission facts have to survive any move to a remote backend: the
	 * credential file itself is `0o600`, and the directories above it are `0o711`
	 * rather than `0o700` so the non-root run user can traverse down to the leaf
	 * without being able to list what else is there. A remote implementation that
	 * silently dropped the mode would either lock the run user out or widen a
	 * credential to world-readable, and neither would fail loudly.
	 *
	 * The parent-directory mode is `dirMode`, applied to every directory this
	 * call has to create.
	 */
	write(
		relPath: string,
		contents: string,
		opts?: { mode?: number; dirMode?: number },
	): Promise<void>;
	/** Create a directory and its parents. `mode` applies to each one created. */
	mkdir(relPath: string, opts?: { mode?: number }): Promise<void>;
}

/** Reject a relative path that would escape the root (`..`, or an absolute path). */
function resolveWithin(root: string, relPath: string): string {
	const full = join(root, relPath);
	const rel = relative(root, full);
	if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
		throw new Error(`sandbox file path escapes its root: ${JSON.stringify(relPath)}`);
	}
	return full;
}

function walk(
	root: string,
	dir: string,
	basename: string,
	maxDepth: number,
	depth: number,
): string[] {
	if (depth > maxDepth) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		// `withFileTypes` reports a symlink as neither file nor directory, so
		// following one is opt-in - and we never opt in.
		if (entry.isDirectory()) out.push(...walk(root, full, basename, maxDepth, depth + 1));
		else if (entry.isFile() && entry.name === basename) out.push(relative(root, full));
	}
	return out;
}

/**
 * {@link SandboxFiles} over the local filesystem, rooted at a host directory.
 *
 * This is the Docker implementation: the run's directory is bind-mounted, so the
 * host path and the container path are the same bytes.
 */
export function hostSandboxFiles(hostRoot: string): SandboxFiles {
	return {
		exists: async (relPath) => existsSync(resolveWithin(hostRoot, relPath)),
		read: async (relPath) => readFileSync(resolveWithin(hostRoot, relPath), 'utf8'),
		remove: async (relPath) => {
			try {
				rmSync(resolveWithin(hostRoot, relPath), { force: true });
			} catch {
				// Best-effort by contract: callers scrub credential-bearing logs here,
				// and the whole per-run directory is removed at cleanup regardless.
			}
		},
		findByName: async (relDir, basename, maxDepth) =>
			walk(hostRoot, resolveWithin(hostRoot, relDir), basename, maxDepth, 0),
		write: async (relPath, contents, opts = {}) => {
			const full = resolveWithin(hostRoot, relPath);
			makeDirs(hostRoot, dirname(full), opts.dirMode);
			writeFileSync(full, contents, opts.mode === undefined ? undefined : { mode: opts.mode });
			// Same umask reasoning as the directories: `writeFileSync`'s mode is
			// masked, and a credential file that came out 0o000 under a strict
			// umask would fail the run rather than leak - but it would fail
			// confusingly, at the CLI, not here.
			if (opts.mode !== undefined) forceMode(full, opts.mode);
		},
		mkdir: async (relPath, opts = {}) => {
			makeDirs(hostRoot, resolveWithin(hostRoot, relPath), opts.mode);
		},
	};
}

/**
 * `mkdir -p` with a mode that survives a strict process umask.
 *
 * `mkdirSync`'s mode is masked by the umask, so on a hardened host (umask 0o027
 * or 0o077, common under systemd `UMask=`) an intended 0o711 is silently
 * stripped to 0o710 or 0o700 - dropping the other-execute bit that lets the
 * deprivileged container run user *traverse* down to its per-run leaf. The agent
 * CLI then fails with EACCES opening a file that was chowned to it correctly.
 * `chmodSync` is not subject to the umask, so every component this call creates
 * is chmod'd afterwards, from the leaf back up to the root of this
 * {@link SandboxFiles} - never above it, which is what bounds the walk.
 */
function makeDirs(root: string, dir: string, mode?: number): void {
	mkdirSync(dir, { recursive: true });
	if (mode === undefined) return;
	let cursor = dir;
	for (;;) {
		forceMode(cursor, mode);
		if (cursor === root) break;
		const parent = dirname(cursor);
		if (parent === cursor || relative(root, parent).startsWith('..')) break;
		cursor = parent;
	}
}

/** Best-effort chmod - a host where we cannot set a mode must not abort the run over it. */
function forceMode(target: string, mode: number): void {
	try {
		chmodSync(target, mode);
	} catch {
		// Best-effort by design; see makeDirs.
	}
}
