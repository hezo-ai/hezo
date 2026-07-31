import { type Dirent, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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
	};
}
