/**
 * {@link SandboxFiles} over Daytona's toolbox file API.
 *
 * This is what makes a whole agent run possible on a managed backend rather than
 * just its container lifecycle. Every artefact a run stages - the prompt file,
 * the per-run runtime home with its `settings.json` and subscription
 * credentials, the tunnel config - and every artefact it reads back - Grok's
 * debug log, Kimi's `wire.jsonl`, the auto-push error log - goes through this
 * interface. The host implementation resolves those relative paths under a bind
 * mount; there is no bind mount here, so they resolve inside the sandbox through
 * the provider's own file transport.
 *
 * Every endpoint below was measured against the live API, and two results are
 * not what the obvious reading of the spec gives: `files/folder` answers **201**
 * rather than 200, and `files/find` matches file *content* rather than names, so
 * `findByName` walks the directory listing exactly as the host implementation
 * walks the filesystem instead of using an endpoint that looks right and
 * silently returns nothing.
 *
 * **Modes are applied, not assumed.** An upload lands `0644` owned by root
 * whatever the caller asked for, so the mode contract - `0600` on a credential,
 * `0711` on the directories above it so the deprivileged run user can traverse
 * without listing - is re-applied explicitly. Dropping it would either lock the
 * run user out or widen a credential to world-readable, and neither fails
 * loudly.
 */

import { logger } from '../../../logger';
import type { SandboxFiles } from '../files';
import type { DaytonaApi, DaytonaSandbox } from './client';

const log = logger.child('daytona-files');

/** Reject a relative path that would escape the root, matching the host implementation. */
function resolveWithin(root: string, relPath: string): string {
	const parts: string[] = [];
	for (const segment of relPath.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (parts.length === 0) {
				throw new Error(`sandbox file path escapes its root: ${JSON.stringify(relPath)}`);
			}
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	if (relPath.startsWith('/')) {
		throw new Error(`sandbox file path must be relative: ${JSON.stringify(relPath)}`);
	}
	return parts.length === 0 ? root : `${root}/${parts.join('/')}`;
}

function parentOf(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * {@link SandboxFiles} rooted at an absolute path *inside* a Daytona sandbox.
 *
 * `sandbox` is passed rather than looked up per call: the toolbox base is
 * per-sandbox and resolving it on every read would add a control-plane round
 * trip to operations that already cost one.
 */
export function daytonaSandboxFiles(
	api: DaytonaApi,
	sandbox: DaytonaSandbox,
	containerRoot: string,
): SandboxFiles {
	const abs = (relPath: string) => resolveWithin(containerRoot, relPath);

	/**
	 * Create a directory and every missing parent.
	 *
	 * The API has no recursive flag, and a folder whose parent is missing fails
	 * without saying so, so the chain is walked from the top. Creating a
	 * directory that already exists is not an error here, which is what makes
	 * this safe to call on every write.
	 */
	const mkdirp = async (absDir: string, mode: number): Promise<void> => {
		const segments = absDir.split('/').filter(Boolean);
		let current = '';
		for (const segment of segments) {
			current = `${current}/${segment}`;
			await api.createFolder(sandbox, current, mode);
		}
	};

	const walk = async (
		absDir: string,
		basename: string,
		maxDepth: number,
		depth: number,
	): Promise<string[]> => {
		if (depth > maxDepth) return [];
		let entries: Awaited<ReturnType<DaytonaApi['listFiles']>>;
		try {
			entries = await api.listFiles(sandbox, absDir);
		} catch {
			// An unreadable directory yields nothing rather than throwing: every
			// caller of findByName is a best-effort scrape.
			return [];
		}
		const found: string[] = [];
		for (const entry of entries) {
			const full = `${absDir}/${entry.name}`;
			if (entry.isDir) found.push(...(await walk(full, basename, maxDepth, depth + 1)));
			else if (entry.name === basename) {
				// Relative to the root, matching the host implementation's contract.
				found.push(
					full.startsWith(`${containerRoot}/`) ? full.slice(containerRoot.length + 1) : full,
				);
			}
		}
		return found;
	};

	return {
		async exists(relPath) {
			// `files/info` rather than a download: it answers for a directory too,
			// where downloading one is a 400 rather than a "no", and it does not pull
			// the file's bytes across just to learn that it is there.
			return (await api.statFile(sandbox, abs(relPath))) !== null;
		},

		async read(relPath) {
			const bytes = await api.downloadFile(sandbox, abs(relPath));
			if (bytes === null) throw new Error(`sandbox file not found: ${relPath}`);
			return new TextDecoder().decode(bytes);
		},

		async readBytes(relPath) {
			const bytes = await api.downloadFile(sandbox, abs(relPath));
			if (bytes === null) throw new Error(`sandbox file not found: ${relPath}`);
			return bytes;
		},

		async size(relPath) {
			// Metadata carries the size, so the file itself is never transferred -
			// which is the whole reason a caller asks before reading. One lookup on
			// the path rather than a listing of its parent, which grows with the
			// directory rather than with the answer.
			try {
				const info = await api.statFile(sandbox, abs(relPath));
				return info && !info.isDir ? info.size : null;
			} catch {
				return null;
			}
		},

		async remove(relPath) {
			try {
				await api.deleteFile(sandbox, abs(relPath));
			} catch (e) {
				// Best-effort by contract - a missing file is not an error, and the
				// callers that scrub a credential file must not fail a run over it.
				log.warn(`could not remove ${relPath}: ${(e as Error).message}`);
			}
		},

		async findByName(relDir, basename, maxDepth) {
			return walk(abs(relDir), basename, maxDepth, 0);
		},

		async write(relPath, contents, opts = {}) {
			const target = abs(relPath);
			await mkdirp(parentOf(target), opts.dirMode ?? 0o755);
			await api.uploadFile(sandbox, target, new TextEncoder().encode(contents), opts.mode);
		},

		async writeBytes(relPath, contents, opts = {}) {
			const target = abs(relPath);
			await mkdirp(parentOf(target), opts.dirMode ?? 0o755);
			await api.uploadFile(sandbox, target, contents, opts.mode);
		},

		async removeDir(relPath) {
			// `recursive` is not optional here: without it the API refuses a
			// non-empty directory outright. The caller that matters is the per-run
			// scrub of the runtime home, which holds the provider credential - so
			// silently leaving the tree in place left that credential on the
			// provider's disk for the rest of the container's life.
			const target = abs(relPath);
			try {
				await api.deleteFile(sandbox, target, { recursive: true });
			} catch (e) {
				// Best-effort by contract, but only for "it was not there". A directory
				// that is still present after a failed delete is a scrub that did not
				// happen, which is worth an error rather than a shrug.
				const stillThere = await api.statFile(sandbox, target).catch(() => null);
				const message = (e as Error).message;
				if (stillThere) {
					log.error(`could not remove directory ${relPath}, it is still present: ${message}`);
				} else {
					log.warn(`could not remove directory ${relPath}: ${message}`);
				}
			}
		},

		async mkdir(relPath, opts = {}) {
			await mkdirp(abs(relPath), opts.mode ?? 0o755);
		},
	};
}
