import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateState } from '@hezo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	applyStagedUpdate,
	currentAssetName,
	downloadAndStage,
	readUpdateState,
} from '../src/services/updater';

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
			return new Response(assetBytes, { status: 200 });
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
