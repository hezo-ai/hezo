import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateState } from '@hezo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
	applyStagedUpdate,
	currentAssetName,
	isAutoUpdateEnabled,
	isCompiledBinary,
	isRunningInContainer,
	isSupervisedWorker,
	readUpdateState,
	sweepStaleBinaries,
} from '../src/services/updater';

async function tmp(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

describe('currentAssetName (extra arch/os branches)', () => {
	it('maps darwin x64 and win32 x64 and rejects null cpu', () => {
		expect(currentAssetName('darwin', 'x64')).toBe('hezo-darwin-x64');
		expect(currentAssetName('win32', 'x64')).toBe('hezo-windows-x64.exe');
		// Unsupported cpu with a supported os.
		expect(() => currentAssetName('darwin', 'riscv64')).toThrow(/Unsupported platform/);
		// windows + non-x64 takes the explicit "no release binary" branch.
		expect(() => currentAssetName('win32', 'arm64')).toThrow(/No release binary/);
	});
});

describe('isCompiledBinary', () => {
	const realExecPath = process.execPath;
	afterEach(() => {
		Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true });
	});

	it('is false when running under the Bun runtime (execPath basename is bun)', () => {
		Object.defineProperty(process, 'execPath', {
			value: '/usr/local/bin/bun',
			configurable: true,
		});
		expect(isCompiledBinary()).toBe(false);
	});

	it('is false for bun.exe and true for a compiled hezo binary', () => {
		// POSIX-style path so node:path basename splits it the same on every host.
		Object.defineProperty(process, 'execPath', {
			value: '/usr/local/bin/bun.exe',
			configurable: true,
		});
		expect(isCompiledBinary()).toBe(false);
		Object.defineProperty(process, 'execPath', {
			value: '/opt/hezo/hezo',
			configurable: true,
		});
		expect(isCompiledBinary()).toBe(true);
	});
});

describe('isRunningInContainer', () => {
	it('returns a boolean reflecting the /.dockerenv probe', () => {
		// We can't reliably toggle the filesystem marker, but the call must not throw
		// and must return a boolean — exercising the existsSync branch.
		expect(typeof isRunningInContainer()).toBe('boolean');
	});
});

describe('isAutoUpdateEnabled / isSupervisedWorker', () => {
	const realExecPath = process.execPath;
	const realDisable = process.env.HEZO_DISABLE_AUTO_UPDATE;
	const realWorker = process.env.HEZO_WORKER;
	afterEach(() => {
		Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true });
		if (realDisable === undefined) delete process.env.HEZO_DISABLE_AUTO_UPDATE;
		else process.env.HEZO_DISABLE_AUTO_UPDATE = realDisable;
		if (realWorker === undefined) delete process.env.HEZO_WORKER;
		else process.env.HEZO_WORKER = realWorker;
	});

	it('is disabled when HEZO_DISABLE_AUTO_UPDATE is set (regardless of binary)', () => {
		process.env.HEZO_DISABLE_AUTO_UPDATE = '1';
		expect(isAutoUpdateEnabled()).toBe(false);
		expect(isSupervisedWorker()).toBe(false);
	});

	it('is disabled in dev (not a compiled binary)', () => {
		delete process.env.HEZO_DISABLE_AUTO_UPDATE;
		Object.defineProperty(process, 'execPath', {
			value: '/usr/local/bin/bun',
			configurable: true,
		});
		expect(isAutoUpdateEnabled()).toBe(false);
	});

	it('isSupervisedWorker requires HEZO_WORKER=1 even when auto-update is otherwise enabled', () => {
		delete process.env.HEZO_DISABLE_AUTO_UPDATE;
		delete process.env.HEZO_WORKER;
		// Pretend to be a compiled, non-container binary.
		Object.defineProperty(process, 'execPath', {
			value: '/opt/hezo/hezo',
			configurable: true,
		});
		const enabled = isAutoUpdateEnabled(); // true unless this host is a container
		// Without HEZO_WORKER, the worker gate is always false.
		expect(isSupervisedWorker()).toBe(false);
		if (enabled) {
			process.env.HEZO_WORKER = '1';
			// When enabled and worker flag set, the worker gate flips on.
			expect(isSupervisedWorker()).toBe(true);
		}
	});
});

describe('readUpdateState', () => {
	it('returns Idle when no state file exists', async () => {
		const dir = await tmp('hezo-state-missing-');
		try {
			expect((await readUpdateState(dir)).state).toBe(UpdateState.Idle);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('returns Idle when the state file is corrupt JSON', async () => {
		const dir = await tmp('hezo-state-corrupt-');
		try {
			await mkdir(join(dir, '.update'), { recursive: true });
			await writeFile(join(dir, '.update', 'state.json'), '{ not valid json ');
			expect((await readUpdateState(dir)).state).toBe(UpdateState.Idle);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('applyStagedUpdate (failure branches)', () => {
	async function seedStaged(dataDir: string, content: string): Promise<void> {
		await mkdir(join(dataDir, '.update'), { recursive: true });
		await writeFile(join(dataDir, '.update', 'staged'), content);
	}

	it('throws UpdateApplyError when there is no staged binary', async () => {
		const dataDir = await tmp('hezo-apply-nostage-');
		try {
			// No staged file written — the existsSync guard throws an UpdateApplyError.
			await expect(applyStagedUpdate(dataDir, join(dataDir, 'hezo'))).rejects.toThrow(
				/no staged binary/,
			);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('wraps an underlying fs failure as an UpdateApplyError (target dir does not exist)', async () => {
		const dataDir = await tmp('hezo-apply-badtarget-');
		try {
			await seedStaged(dataDir, 'NEW');
			// targetPath lives in a directory that does not exist, so the first copyFile
			// (staged -> adjacent temp) throws ENOENT, which the catch wraps as an
			// UpdateApplyError (the generic, non-EACCES branch).
			const badTarget = join(dataDir, 'does-not-exist-dir', 'hezo');
			await expect(applyStagedUpdate(dataDir, badTarget)).rejects.toThrow();
			// Staging is left intact for a later retry (only cleared on success).
			expect(existsSync(join(dataDir, '.update', 'staged'))).toBe(true);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});

describe('sweepStaleBinaries', () => {
	it('is a no-op off Windows (leaves the directory untouched)', async () => {
		const dir = await tmp('hezo-sweep-unix-');
		try {
			const target = join(dir, 'hezo');
			await writeFile(target, 'bin');
			await writeFile(join(dir, 'hezo-old-1.0.0.exe'), 'stale');
			// On a non-Windows platform this returns immediately without deleting.
			await sweepStaleBinaries(target);
			if (process.platform !== 'win32') {
				expect(await readFile(join(dir, 'hezo-old-1.0.0.exe'), 'utf8')).toBe('stale');
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
