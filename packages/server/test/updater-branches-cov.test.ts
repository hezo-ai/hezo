import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateState } from '@hezo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	applyStagedUpdate,
	currentAssetName,
	downloadAndStage,
	isAutoUpdateEnabled,
	isCompiledBinary,
	isRunningInContainer,
	isSupervisedWorker,
	readUpdateState,
	sweepStaleBinaries,
	UpdateApplyError,
} from '../src/services/updater';
import { HEZO_VERSION } from '../src/version';
import { blobBytes } from './helpers';

async function tmp(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

/** Swap process.platform for a test and hand back a restore function. */
function setPlatform(platform: string): () => void {
	const original = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	return () => {
		if (original) Object.defineProperty(process, 'platform', original);
	};
}

describe('availability predicates', () => {
	const savedDisable = process.env.HEZO_DISABLE_AUTO_UPDATE;
	const savedWorker = process.env.HEZO_WORKER;

	afterEach(() => {
		if (savedDisable === undefined) delete process.env.HEZO_DISABLE_AUTO_UPDATE;
		else process.env.HEZO_DISABLE_AUTO_UPDATE = savedDisable;
		if (savedWorker === undefined) delete process.env.HEZO_WORKER;
		else process.env.HEZO_WORKER = savedWorker;
	});

	it('vitest runs under Node, so execPath is not the bun runtime and reads as a compiled binary', () => {
		// basename(process.execPath) is `node` in the vitest forks pool — the
		// dev-mode escape hatch only triggers for the literal bun executable.
		expect(isCompiledBinary()).toBe(true);
	});

	it('container detection follows the /.dockerenv marker', () => {
		expect(isRunningInContainer()).toBe(existsSync('/.dockerenv'));
	});

	it('HEZO_DISABLE_AUTO_UPDATE force-disables the feature regardless of everything else', () => {
		process.env.HEZO_DISABLE_AUTO_UPDATE = '1';
		process.env.HEZO_WORKER = '1';
		expect(isAutoUpdateEnabled()).toBe(false);
		expect(isSupervisedWorker()).toBe(false);
	});

	it('with no disable flag, availability under Node hinges only on the container check', () => {
		delete process.env.HEZO_DISABLE_AUTO_UPDATE;
		// isCompiledBinary() is true under Node (above), so the container gate is
		// the only remaining condition.
		expect(isAutoUpdateEnabled()).toBe(!isRunningInContainer());
	});

	it('isSupervisedWorker requires HEZO_WORKER=1 on top of the feature gate', () => {
		delete process.env.HEZO_DISABLE_AUTO_UPDATE;
		delete process.env.HEZO_WORKER;
		expect(isSupervisedWorker()).toBe(false);
		process.env.HEZO_WORKER = '0';
		expect(isSupervisedWorker()).toBe(false);
		process.env.HEZO_WORKER = '1';
		expect(isSupervisedWorker()).toBe(isAutoUpdateEnabled());
	});
});

describe('downloadAndStage manifest parsing', () => {
	afterEach(() => vi.restoreAllMocks());

	function mockRelease(assetBytes: Buffer, sumsText: string) {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/SHA256SUMS')) return new Response(sumsText, { status: 200 });
			return new Response(blobBytes(assetBytes), { status: 200 });
		});
	}

	it('accepts the `<hex> *<filename>` binary-mode manifest format', async () => {
		const dir = await tmp('hezo-sums-binmode-');
		try {
			const bytes = Buffer.from('binary-mode manifest binary');
			const sha = createHash('sha256').update(bytes).digest('hex');
			mockRelease(bytes, `${sha} *${currentAssetName()}\n`);

			await downloadAndStage('9.9.9', dir);

			expect((await readUpdateState(dir)).state).toBe(UpdateState.Staged);
			const staged = await readFile(join(dir, '.update', 'staged'));
			expect(Buffer.compare(staged, bytes)).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('errors when the manifest has no entry for this asset', async () => {
		const dir = await tmp('hezo-sums-missing-');
		try {
			const bytes = Buffer.from('some binary');
			const sha = createHash('sha256').update(bytes).digest('hex');
			// Manifest lists a different asset plus a malformed line — neither matches.
			mockRelease(bytes, `${sha}  hezo-some-other-asset\nnot a sums line at all\n`);

			await expect(downloadAndStage('9.9.9', dir)).rejects.toThrow(/no SHA256 entry/);

			const state = await readUpdateState(dir);
			expect(state.state).toBe(UpdateState.Error);
			expect(state.error).toMatch(/no SHA256 entry/);
			expect(existsSync(join(dir, '.update', 'staged'))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('runs the macOS quarantine strip (best-effort) and still stages', async () => {
		const restore = setPlatform('darwin');
		const dir = await tmp('hezo-darwin-stage-');
		try {
			const bytes = Buffer.from('a darwin binary');
			const sha = createHash('sha256').update(bytes).digest('hex');
			mockRelease(bytes, `${sha}  ${currentAssetName()}\n`);

			// On this host `xattr` is either absent (spawn error) or reports a missing
			// attribute — stripQuarantine must swallow both and staging must complete.
			await downloadAndStage('9.9.9', dir);

			expect((await readUpdateState(dir)).state).toBe(UpdateState.Staged);
			const staged = await readFile(join(dir, '.update', 'staged'));
			expect(Buffer.compare(staged, bytes)).toBe(0);
		} finally {
			restore();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('applyStagedUpdate Windows rollback', () => {
	it('restores the original exe when the replacement verifies as empty', async () => {
		const dir = await tmp('hezo-win-rollback-');
		try {
			const dataDir = join(dir, 'data');
			await mkdir(join(dataDir, '.update'), { recursive: true });
			// A zero-byte staged binary trips the post-rename size check.
			await writeFile(join(dataDir, '.update', 'staged'), Buffer.alloc(0));

			const target = join(dir, 'myapp.exe');
			await writeFile(target, 'ORIGINAL BINARY');

			await expect(applyStagedUpdate(dataDir, target)).rejects.toBeInstanceOf(UpdateApplyError);

			// Rolled back: original restored, no backup or temp file left behind.
			expect(await readFile(target, 'utf8')).toBe('ORIGINAL BINARY');
			expect(existsSync(join(dir, `myapp-old-${HEZO_VERSION}.exe`))).toBe(false);
			expect(existsSync(join(dir, '.hezo-update-tmp.exe'))).toBe(false);
			// Staging is NOT cleared on failure — a later attempt can retry.
			expect(existsSync(join(dataDir, '.update', 'staged'))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('sweepStaleBinaries', () => {
	it('is a no-op off Windows', async () => {
		const dir = await tmp('hezo-sweep-noop-');
		try {
			const stale = join(dir, `app-old-${HEZO_VERSION}.exe`);
			await writeFile(stale, 'old');
			await sweepStaleBinaries(join(dir, 'app.exe'));
			expect(existsSync(stale)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('removes only `<name>-old-*.exe` siblings on Windows (case-insensitive extension)', async () => {
		const restore = setPlatform('win32');
		const dir = await tmp('hezo-sweep-win-');
		try {
			await writeFile(join(dir, 'myapp.exe'), 'live');
			await writeFile(join(dir, 'myapp-old-1.0.0.exe'), 'stale');
			await writeFile(join(dir, 'myapp-old-1.1.0.EXE'), 'stale upper ext');
			await writeFile(join(dir, 'myapp-old-notes.txt'), 'not an exe');
			await writeFile(join(dir, 'other-old-1.0.0.exe'), 'different prefix');

			await sweepStaleBinaries(join(dir, 'myapp.exe'));

			const left = (await readdir(dir)).sort();
			expect(left).toEqual(['myapp-old-notes.txt', 'myapp.exe', 'other-old-1.0.0.exe']);
		} finally {
			restore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('swallows an unreadable directory instead of throwing', async () => {
		const restore = setPlatform('win32');
		try {
			await expect(
				sweepStaleBinaries(join(tmpdir(), 'hezo-does-not-exist-abc', 'app.exe')),
			).resolves.toBeUndefined();
		} finally {
			restore();
		}
	});
});
