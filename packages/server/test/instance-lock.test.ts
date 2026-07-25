import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	instanceLockPath,
	readLiveInstanceLock,
	removeInstanceLock,
	writeInstanceLock,
} from '../src/db/instance-lock';

// The advisory lock the embedded server drops so the backup/restore preflight
// can refuse while it is live. Cross-OS: liveness rides on `process.kill(pid, 0)`,
// which is a pure existence check on Linux, macOS, and Windows.

// A PID no real process could hold (well above any platform's pid_max), so its
// liveness probe returns ESRCH deterministically → treated as a stale/dead lock.
const DEAD_PID = 2_147_483_646;

const dirs: string[] = [];
function tmpDataDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'hezo-lock-'));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('instance lock', () => {
	it('instanceLockPath is <dataDir>/hezo.lock', () => {
		const dir = tmpDataDir();
		expect(instanceLockPath(dir)).toBe(join(dir, 'hezo.lock'));
	});

	it('writes the current PID and reads it back while this process is alive', () => {
		const dir = tmpDataDir();
		writeInstanceLock(dir);
		expect(existsSync(instanceLockPath(dir))).toBe(true);
		expect(readFileSync(instanceLockPath(dir), 'utf8').trim()).toBe(String(process.pid));
		// This test process is obviously alive, so the lock reads as live.
		expect(readLiveInstanceLock(dir)).toEqual({ pid: process.pid });
	});

	it('reports no live lock once removed', () => {
		const dir = tmpDataDir();
		writeInstanceLock(dir);
		removeInstanceLock(dir);
		expect(existsSync(instanceLockPath(dir))).toBe(false);
		expect(readLiveInstanceLock(dir)).toBeNull();
	});

	it('treats a stale lock (dead PID) as no live server', () => {
		const dir = tmpDataDir();
		writeFileSync(instanceLockPath(dir), `${DEAD_PID}\n`, 'utf8');
		expect(readLiveInstanceLock(dir)).toBeNull();
	});

	it('returns null for an absent lock', () => {
		expect(readLiveInstanceLock(tmpDataDir())).toBeNull();
	});

	it('returns null for a malformed lock', () => {
		for (const bad of ['not-a-pid', '', '0', '-5', '   ']) {
			const dir = tmpDataDir();
			writeFileSync(instanceLockPath(dir), bad, 'utf8');
			expect(readLiveInstanceLock(dir), `bad lock: ${JSON.stringify(bad)}`).toBeNull();
		}
	});

	it('removeInstanceLock is a no-op when the lock is absent', () => {
		expect(() => removeInstanceLock(tmpDataDir())).not.toThrow();
	});
});
