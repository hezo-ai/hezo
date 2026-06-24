import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateState } from '@hezo/shared';
import { applyStagedUpdate } from '../../src/services/updater';

// Runtime tier: the supervisor detects the restart sentinel via `Bun.spawn`'s
// exit-code propagation, and `applyStagedUpdate` swaps the binary with node:fs
// primitives. vitest runs under Node, so these contracts are pinned here on the
// production Bun runtime where the supervisor actually runs.

describe('Bun.spawn exit-code propagation (supervisor sentinel routing)', () => {
	async function spawnExit(code: number): Promise<number> {
		const dir = await mkdtemp(join(tmpdir(), 'hezo-spawn-'));
		const script = join(dir, 'exit.js');
		await writeFile(script, `process.exit(${code});`);
		try {
			const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'ignore' });
			return await child.exited;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	test('propagates the restart sentinel code 75', async () => {
		expect(await spawnExit(75)).toBe(75);
	});

	test('propagates a normal exit code 0', async () => {
		expect(await spawnExit(0)).toBe(0);
	});
});

describe('applyStagedUpdate on the Bun runtime', () => {
	async function seed(dataDir: string, content: string): Promise<void> {
		await mkdir(join(dataDir, '.update'), { recursive: true });
		await writeFile(join(dataDir, '.update', 'staged'), content);
		await writeFile(
			join(dataDir, '.update', 'state.json'),
			JSON.stringify({ state: UpdateState.Staged, targetVersion: '9.9.9' }),
		);
	}

	test('Unix atomic rename replaces the target binary', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'hezo-bun-apply-'));
		const binDir = await mkdtemp(join(tmpdir(), 'hezo-bun-bin-'));
		const target = join(binDir, 'hezo');
		try {
			await writeFile(target, 'OLD');
			await seed(dataDir, 'NEW');
			await applyStagedUpdate(dataDir, target);
			expect(await readFile(target, 'utf8')).toBe('NEW');
			expect(existsSync(join(dataDir, '.update'))).toBe(false);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
			await rm(binDir, { recursive: true, force: true });
		}
	});

	test('Windows rename-trick branch replaces the .exe target', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'hezo-bun-applyw-'));
		const binDir = await mkdtemp(join(tmpdir(), 'hezo-bun-binw-'));
		const target = join(binDir, 'hezo.exe');
		try {
			await writeFile(target, 'OLD');
			await seed(dataDir, 'NEW');
			await applyStagedUpdate(dataDir, target);
			expect(await readFile(target, 'utf8')).toBe('NEW');
		} finally {
			await rm(dataDir, { recursive: true, force: true });
			await rm(binDir, { recursive: true, force: true });
		}
	});
});
