import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateState } from '@hezo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ASSET_DOWNLOAD_TIMEOUT_MS,
	applyStagedUpdate,
	currentAssetName,
	downloadAndStage,
	ensureUpdateStaged,
	readUpdateState,
	STAGE_DOWNLOAD_STALE_MS,
	STAGE_ERROR_COOLDOWN_MS,
} from '../src/services/updater';
import { blobBytes } from './helpers';

describe('staging timing invariants', () => {
	it('keeps the staleness window above the download timeout so a slow live download is never preempted', () => {
		expect(STAGE_DOWNLOAD_STALE_MS).toBeGreaterThan(ASSET_DOWNLOAD_TIMEOUT_MS);
	});
});

async function tmp(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

describe('currentAssetName', () => {
	it('maps platform/arch to the release asset name', () => {
		expect(currentAssetName('linux', 'x64')).toBe('hezo-linux-x64');
		expect(currentAssetName('linux', 'arm64')).toBe('hezo-linux-arm64');
		expect(currentAssetName('darwin', 'arm64')).toBe('hezo-darwin-arm64');
		expect(currentAssetName('win32', 'x64')).toBe('hezo-windows-x64.exe');
	});

	it('throws on unsupported platform/arch', () => {
		expect(() => currentAssetName('freebsd', 'x64')).toThrow();
		expect(() => currentAssetName('linux', 'mips')).toThrow();
		expect(() => currentAssetName('win32', 'arm64')).toThrow();
	});
});

describe('downloadAndStage', () => {
	afterEach(() => vi.restoreAllMocks());

	function mockRelease(assetBytes: Buffer, sumsText: string) {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/SHA256SUMS')) {
				return new Response(sumsText, { status: 200 });
			}
			return new Response(blobBytes(assetBytes), { status: 200 });
		});
	}

	it('verifies the sha256 and stages the binary', async () => {
		const dir = await tmp('hezo-stage-ok-');
		try {
			const bytes = Buffer.from('a brand new hezo binary');
			const asset = currentAssetName();
			const sha = createHash('sha256').update(bytes).digest('hex');
			mockRelease(bytes, `${sha}  ${asset}\n`);

			await downloadAndStage('9.9.9', dir);

			const staged = await readFile(join(dir, '.update', 'staged'));
			expect(Buffer.compare(staged, bytes)).toBe(0);
			const state = await readUpdateState(dir);
			expect(state.state).toBe(UpdateState.Staged);
			expect(state.targetVersion).toBe('9.9.9');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('rejects a tampered binary and records an error state', async () => {
		const dir = await tmp('hezo-stage-bad-');
		try {
			const bytes = Buffer.from('a brand new hezo binary');
			const asset = currentAssetName();
			mockRelease(bytes, `${'0'.repeat(64)}  ${asset}\n`); // wrong hash

			await expect(downloadAndStage('9.9.9', dir)).rejects.toThrow(/SHA256/);

			expect(existsSync(join(dir, '.update', 'staged'))).toBe(false);
			const state = await readUpdateState(dir);
			expect(state.state).toBe(UpdateState.Error);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('ensureUpdateStaged', () => {
	afterEach(() => vi.restoreAllMocks());

	/** A stubbed latest-release lookup (no network). */
	const latest =
		(updateAvailable = true, version: string | null = '9.9.9') =>
		async () => ({ updateAvailable, latest: version });

	async function seedState(dir: string, s: Record<string, unknown>): Promise<void> {
		await mkdir(join(dir, '.update'), { recursive: true });
		await writeFile(join(dir, '.update', 'state.json'), JSON.stringify(s));
	}

	/** Mock a healthy release; `onAsset` lets a test fail specific attempts. */
	function mockRelease(bytes: Buffer, onAsset?: () => Response | null) {
		const sha = createHash('sha256').update(bytes).digest('hex');
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/SHA256SUMS')) {
				return new Response(`${sha}  ${currentAssetName()}\n`, { status: 200 });
			}
			return onAsset?.() ?? new Response(blobBytes(bytes), { status: 200 });
		});
	}

	it('stages when idle and an update is available', async () => {
		const dir = await tmp('hezo-ensure-idle-');
		try {
			const fetchSpy = mockRelease(Buffer.from('new binary'));
			await ensureUpdateStaged(dir, latest());
			expect(fetchSpy).toHaveBeenCalled();
			const state = await readUpdateState(dir);
			expect(state.state).toBe(UpdateState.Staged);
			expect(state.targetVersion).toBe('9.9.9');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('no-ops when no newer release is available', async () => {
		const dir = await tmp('hezo-ensure-none-');
		try {
			const fetchSpy = vi.spyOn(globalThis, 'fetch');
			await ensureUpdateStaged(dir, latest(false, null));
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('no-ops when already staged for the same version', async () => {
		const dir = await tmp('hezo-ensure-staged-');
		try {
			await seedState(dir, { state: UpdateState.Staged, targetVersion: '9.9.9' });
			const fetchSpy = vi.spyOn(globalThis, 'fetch');
			await ensureUpdateStaged(dir, latest());
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('no-ops while a fresh download is in flight', async () => {
		const dir = await tmp('hezo-ensure-downloading-');
		try {
			await seedState(dir, {
				state: UpdateState.Downloading,
				targetVersion: '9.9.9',
				updatedAt: Date.now(),
			});
			const fetchSpy = vi.spyOn(globalThis, 'fetch');
			await ensureUpdateStaged(dir, latest());
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('re-attempts a stale (abandoned) download', async () => {
		const dir = await tmp('hezo-ensure-downloading-stale-');
		try {
			await seedState(dir, {
				state: UpdateState.Downloading,
				targetVersion: '9.9.9',
				updatedAt: Date.now() - STAGE_DOWNLOAD_STALE_MS - 1,
			});
			mockRelease(Buffer.from('new binary'));
			await ensureUpdateStaged(dir, latest());
			expect((await readUpdateState(dir)).state).toBe(UpdateState.Staged);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('respects the error cooldown (does not re-download within the window)', async () => {
		const dir = await tmp('hezo-ensure-errored-fresh-');
		try {
			await seedState(dir, {
				state: UpdateState.Error,
				targetVersion: '9.9.9',
				updatedAt: Date.now(),
			});
			const fetchSpy = vi.spyOn(globalThis, 'fetch');
			await ensureUpdateStaged(dir, latest());
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('re-attempts a download once the error cooldown has elapsed', async () => {
		const dir = await tmp('hezo-ensure-errored-stale-');
		try {
			await seedState(dir, {
				state: UpdateState.Error,
				targetVersion: '9.9.9',
				updatedAt: Date.now() - STAGE_ERROR_COOLDOWN_MS - 1,
			});
			mockRelease(Buffer.from('new binary'));
			await ensureUpdateStaged(dir, latest());
			expect((await readUpdateState(dir)).state).toBe(UpdateState.Staged);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('retries the download once before succeeding', async () => {
		const dir = await tmp('hezo-ensure-retry-ok-');
		try {
			let assetCalls = 0;
			mockRelease(Buffer.from('new binary'), () => {
				assetCalls++;
				return assetCalls === 1 ? new Response('boom', { status: 500 }) : null;
			});
			await ensureUpdateStaged(dir, latest());
			expect(assetCalls).toBe(2); // first attempt failed, retry succeeded
			expect((await readUpdateState(dir)).state).toBe(UpdateState.Staged);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('records an error (and swallows it) after the retry also fails', async () => {
		const dir = await tmp('hezo-ensure-retry-fail-');
		try {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
			// Must not throw — it's fire-and-forget from the status poll/cron.
			await expect(ensureUpdateStaged(dir, latest())).resolves.toBeUndefined();
			expect((await readUpdateState(dir)).state).toBe(UpdateState.Error);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('applyStagedUpdate', () => {
	async function seedStaged(dataDir: string, content: string): Promise<void> {
		await mkdir(join(dataDir, '.update'), { recursive: true });
		await writeFile(join(dataDir, '.update', 'staged'), content);
		await writeFile(
			join(dataDir, '.update', 'state.json'),
			JSON.stringify({ state: UpdateState.Staged, targetVersion: '9.9.9' }),
		);
	}

	it('atomically replaces the target binary (Unix rename) and clears staging', async () => {
		const dataDir = await tmp('hezo-apply-unix-');
		const binDir = await tmp('hezo-bin-unix-');
		const target = join(binDir, 'hezo');
		try {
			await writeFile(target, 'OLD BINARY');
			await seedStaged(dataDir, 'NEW BINARY');

			await applyStagedUpdate(dataDir, target);

			expect(await readFile(target, 'utf8')).toBe('NEW BINARY');
			expect(existsSync(join(dataDir, '.update'))).toBe(false);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
			await rm(binDir, { recursive: true, force: true });
		}
	});

	it('replaces the target via the Windows rename-trick branch (.exe target)', async () => {
		const dataDir = await tmp('hezo-apply-win-');
		const binDir = await tmp('hezo-bin-win-');
		const target = join(binDir, 'hezo.exe');
		try {
			await writeFile(target, 'OLD BINARY');
			await seedStaged(dataDir, 'NEW BINARY');

			await applyStagedUpdate(dataDir, target);

			expect(await readFile(target, 'utf8')).toBe('NEW BINARY');
			expect(existsSync(join(dataDir, '.update'))).toBe(false);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
			await rm(binDir, { recursive: true, force: true });
		}
	});

	it('throws when there is no staged binary', async () => {
		const dataDir = await tmp('hezo-apply-none-');
		try {
			await expect(applyStagedUpdate(dataDir, join(dataDir, 'hezo'))).rejects.toThrow();
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
