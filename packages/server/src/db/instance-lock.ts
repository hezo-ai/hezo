import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';

const log = logger.child('instance-lock');

const LOCK_FILENAME = 'hezo.lock';

/**
 * Advisory instance lock for the **embedded** database.
 *
 * PGlite is single-process: a `hezo backup` / `hezo restore` invocation opens a
 * *second* Postgres cluster (in WASM) over the same `pgdata` files. That is not
 * a read-only act — opening a cluster runs crash recovery and rewrites control
 * files — so it races a live server's writes and can corrupt the data. PGlite
 * provides no interlock of its own, so the running embedded server drops this
 * advisory lock (its own OS PID) and the backup/restore preflight refuses while
 * it is live. External Postgres manages its own concurrency and needs no lock.
 *
 * The lock is *advisory*, consumed only by the backup/restore preflight — it is
 * never a gate on server startup. A hard crash (SIGKILL, power loss) leaves the
 * file behind with a now-dead PID; the next server start simply overwrites it,
 * and `readLiveInstanceLock` treats a dead PID as "no server" via a liveness
 * probe, so a stale lock never blocks anything.
 */
export function instanceLockPath(dataDir: string): string {
	return join(dataDir, LOCK_FILENAME);
}

export interface InstanceLockInfo {
	pid: number;
}

let exitHookRegistered = false;

/**
 * Cross-platform liveness probe. `process.kill(pid, 0)` sends no signal — it
 * only checks whether the process exists — and behaves consistently on the OSes
 * we ship binaries for (Linux, macOS, Windows): Bun/libuv map a missing process
 * to `ESRCH`, an existing-but-unowned one to `EPERM`.
 *
 * `ESRCH` is the ONLY outcome treated as "not alive". Any other result — `EPERM`
 * (the process exists but is owned by another user) or an unexpected code from a
 * platform quirk — is treated as alive. Callers use this to decide whether to
 * refuse a destructive-adjacent operation, so erring toward "alive" fails safe:
 * the worst case is a false refusal (recoverable by deleting the lock file),
 * never a false "all clear" that proceeds while a server is running.
 */
function isProcessAlive(pid: number): boolean {
	// A non-positive pid would target a process *group* on POSIX (pid 0 = the
	// caller's group), so never probe it — treat as not a real owner.
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

/**
 * Record this process as the live owner of `dataDir`'s embedded database. Writes
 * the current PID to `<dataDir>/hezo.lock`, overwriting any stale lock, and
 * registers a best-effort removal on process exit (fires for graceful shutdown,
 * which routes through `process.exit`). Best-effort: a failure to write is logged
 * and swallowed — the lock is advisory and must never stop the server booting.
 */
export function writeInstanceLock(dataDir: string): void {
	const path = instanceLockPath(dataDir);
	try {
		writeFileSync(path, `${process.pid}\n`, 'utf8');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn(`Could not write instance lock at ${path} (continuing): ${msg}`);
		return;
	}
	if (!exitHookRegistered) {
		exitHookRegistered = true;
		// `exit` handlers must be synchronous; unlinkSync is. Fires on graceful
		// SIGTERM/SIGINT (which call process.exit) and normal termination.
		process.on('exit', () => removeInstanceLock(dataDir));
	}
}

/** Best-effort synchronous removal of the lock. Missing file / errors are ignored. */
export function removeInstanceLock(dataDir: string): void {
	try {
		unlinkSync(instanceLockPath(dataDir));
	} catch {
		// Already gone, or unwritable — nothing to do.
	}
}

/**
 * Read `<dataDir>/hezo.lock` and return the owning PID **only if that process is
 * still alive**. Returns `null` when the lock is absent, malformed, or its PID is
 * a definitively-dead process — i.e. "no live embedded server is using this data
 * directory". Reads through the filesystem, so it works with the server stopped.
 */
export function readLiveInstanceLock(dataDir: string): InstanceLockInfo | null {
	let raw: string;
	try {
		raw = readFileSync(instanceLockPath(dataDir), 'utf8');
	} catch {
		return null; // absent or unreadable → treat as no live server.
	}
	const pid = Number.parseInt(raw.trim(), 10);
	if (!Number.isInteger(pid) || pid <= 0) return null; // malformed lock.
	return isProcessAlive(pid) ? { pid } : null;
}
