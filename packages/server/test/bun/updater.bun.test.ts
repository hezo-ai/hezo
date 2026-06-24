import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateState } from '@hezo/shared';
import { applyStagedUpdate } from '../../src/services/updater';

// Runtime tier: the supervisor detects the restart sentinel via `Bun.spawn`'s
// exit-code propagation, and `applyStagedUpdate` swaps the binary with node:fs
// primitives whose behaviour depends on the host OS. vitest runs under Node, so
// these contracts are pinned here on the production Bun runtime.
//
// The swap test below is PLATFORM-ADAPTIVE: it builds a real, running executable
// for whatever OS you run it on and replaces it in place, so running
// `bun test test/bun/updater.bun.test.ts` on Windows exercises the Windows
// rename-trick, and on macOS/Linux the atomic rename — each against the real
// file-locking semantics that production hits. (Branch-level coverage of both
// strategies on any OS lives in the fast vitest tier, test/updater.test.ts.)

async function seedStaged(dataDir: string, content: string): Promise<void> {
	await mkdir(join(dataDir, '.update'), { recursive: true });
	await writeFile(join(dataDir, '.update', 'staged'), content);
	await writeFile(
		join(dataDir, '.update', 'state.json'),
		JSON.stringify({ state: UpdateState.Staged, targetVersion: '9.9.9' }),
	);
}

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

describe('applyStagedUpdate replaces a live binary on this platform', () => {
	// Runs the real swap strategy for `process.platform` against a genuine,
	// currently-executing binary — the production condition the unit tests can't
	// reproduce (Windows locks the running .exe; Unix holds the executing inode).
	test(`swaps a running ${process.platform} executable in place`, async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'hezo-live-data-'));
		const binDir = await mkdtemp(join(tmpdir(), 'hezo-live-bin-'));
		const isWindows = process.platform === 'win32';
		const target = join(binDir, isWindows ? 'hezo.exe' : 'hezo');
		let child: ReturnType<typeof Bun.spawn> | undefined;

		try {
			// A real executable for THIS platform: a copy of the running runtime.
			await copyFile(process.execPath, target);
			if (!isWindows) await chmod(target, 0o755);

			// Keep it running so the OS holds the file exactly as it would the live
			// server binary (locked on Windows, an executing inode on Unix).
			const sleeper = join(binDir, 'stay-alive.js');
			await writeFile(sleeper, 'setTimeout(() => {}, 60_000);');
			child = Bun.spawn([target, sleeper], { stdout: 'ignore', stderr: 'ignore' });
			// Give it a moment to actually start executing the target file.
			await new Promise((resolve) => setTimeout(resolve, 750));
			expect(child.pid).toBeGreaterThan(0);
			expect(child.exitCode).toBeNull(); // genuinely running

			await seedStaged(dataDir, 'REPLACED BINARY');
			// process.platform selects the right strategy for this OS.
			await applyStagedUpdate(dataDir, target);

			// The on-disk binary is the new one, and staging is cleared.
			expect(await readFile(target, 'utf8')).toBe('REPLACED BINARY');
			expect(existsSync(join(dataDir, '.update'))).toBe(false);
			// The already-running process is untouched by the swap.
			expect(child.exitCode).toBeNull();
		} finally {
			child?.kill();
			await child?.exited;
			await rm(dataDir, { recursive: true, force: true }).catch(() => {});
			await rm(binDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
