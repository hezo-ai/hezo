import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostSandboxFiles } from '../src/services/sandbox/files';

/**
 * The seam that lets a run's artifact files be read back from somewhere other
 * than a bind mount. What matters here is the contract every implementation has
 * to honour - relative paths only, best-effort deletes, a bounded search that
 * cannot be walked out of - because a remote implementation will be written
 * against these expectations rather than against node:fs.
 */
describe('hostSandboxFiles', () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'hezo-sandbox-files-'));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('round-trips a file by relative path', async () => {
		writeFileSync(join(root, 'debug.log'), 'hello');
		const files = hostSandboxFiles(root);
		expect(await files.exists('debug.log')).toBe(true);
		expect(await files.read('debug.log')).toBe('hello');
	});

	it('reports a missing file rather than throwing on exists', async () => {
		expect(await hostSandboxFiles(root).exists('nope.log')).toBe(false);
	});

	it('swallows a delete of something that is not there', async () => {
		// Callers scrub credential-bearing logs in a `finally`, so a delete that
		// throws would mask the real error from the block it is unwinding.
		await expect(hostSandboxFiles(root).remove('nope.log')).resolves.toBeUndefined();
	});

	it('refuses a path that escapes the root', async () => {
		const files = hostSandboxFiles(root);
		// An absolute host path or a `..` climb would work fine under Docker and
		// be meaningless against a provider file API - so it is rejected here,
		// where it is a loud error, rather than silently only working locally.
		await expect(files.read('../outside.txt')).rejects.toThrow(/escapes its root/);
		await expect(files.exists('a/../../outside.txt')).rejects.toThrow(/escapes its root/);
	});

	it('allows a `..` that stays inside the root', async () => {
		mkdirSync(join(root, 'a'), { recursive: true });
		writeFileSync(join(root, 'inside.txt'), 'ok');
		expect(await hostSandboxFiles(root).read('a/../inside.txt')).toBe('ok');
	});

	describe('findByName', () => {
		it('finds nested files and returns paths relative to the root', async () => {
			const dir = join(root, 'sessions', 'ws-1', 'sess-1');
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'wire.jsonl'), '{}');
			const found = await hostSandboxFiles(root).findByName('sessions', 'wire.jsonl', 8);
			// Relative, so the caller can hand the same string straight back to
			// read() and remove() without knowing where the root actually is.
			expect(found).toEqual([join('sessions', 'ws-1', 'sess-1', 'wire.jsonl')]);
		});

		it('honours the depth cap', async () => {
			const deep = join(root, 'a', 'b', 'c');
			mkdirSync(deep, { recursive: true });
			writeFileSync(join(deep, 'wire.jsonl'), '{}');
			expect(await hostSandboxFiles(root).findByName('a', 'wire.jsonl', 0)).toEqual([]);
			expect(await hostSandboxFiles(root).findByName('a', 'wire.jsonl', 8)).toHaveLength(1);
		});

		it('never follows a symlink, so the depth cap is a real bound', async () => {
			const dir = join(root, 'sessions');
			mkdirSync(dir, { recursive: true });
			// A self-referential directory link would make a depth-bounded walk
			// unbounded if links were followed.
			symlinkSync(root, join(dir, 'loop'));
			writeFileSync(join(dir, 'wire.jsonl'), '{}');
			const found = await hostSandboxFiles(root).findByName('sessions', 'wire.jsonl', 8);
			expect(found).toEqual([join('sessions', 'wire.jsonl')]);
		});

		it('yields nothing for a directory that is not there', async () => {
			expect(await hostSandboxFiles(root).findByName('missing', 'wire.jsonl', 8)).toEqual([]);
		});
	});
});

/**
 * The write side exists so host-written, container-read files (the prompt, a
 * subscription credential, runtime config) can move to a backend whose
 * container is not on this machine. Modes are part of that contract, not a
 * detail - the container reads them as a *deprivileged* user.
 */
describe('hostSandboxFiles write side', () => {
	it('writes a file, creating its parent directories', async () => {
		const root = mkdtempSync(join(tmpdir(), 'sbx-write-'));
		const files = hostSandboxFiles(root);
		await files.write('.hezo/prompts/run-1.txt', 'do the thing');
		expect(await files.read('.hezo/prompts/run-1.txt')).toBe('do the thing');
		rmSync(root, { recursive: true, force: true });
	});

	it('applies the file mode even under a strict umask', async () => {
		// writeFileSync's mode is masked by the process umask, so a 0o600
		// credential can come out 0o000 on a hardened host - which fails the run
		// confusingly, at the agent CLI, rather than here.
		const prev = process.umask(0o077);
		try {
			const root = mkdtempSync(join(tmpdir(), 'sbx-mode-'));
			const files = hostSandboxFiles(root);
			await files.write('auth.json', '{"token":"x"}', { mode: 0o600 });
			expect(statSync(join(root, 'auth.json')).mode & 0o777).toBe(0o600);
			rmSync(root, { recursive: true, force: true });
		} finally {
			process.umask(prev);
		}
	});

	it('keeps the traversal bit on parent dirs under a strict umask', async () => {
		// 0o711 rather than 0o700 so the non-root run user can traverse down to
		// its per-run leaf without being able to list what else is there. A umask
		// of 0o077 strips the other-execute bit from mkdirSync's mode.
		const prev = process.umask(0o077);
		try {
			const root = mkdtempSync(join(tmpdir(), 'sbx-dir-'));
			const files = hostSandboxFiles(root);
			await files.write('subscription/anthropic/run-1/auth.json', 'v', {
				mode: 0o600,
				dirMode: 0o711,
			});
			for (const rel of [
				'subscription',
				'subscription/anthropic',
				'subscription/anthropic/run-1',
			]) {
				expect(statSync(join(root, rel)).mode & 0o777, rel).toBe(0o711);
			}
			rmSync(root, { recursive: true, force: true });
		} finally {
			process.umask(prev);
		}
	});

	it('never chmods above its own root', async () => {
		// The root is the boundary that bounds the walk - reaching past it would
		// re-mode directories this SandboxFiles does not own.
		const parent = mkdtempSync(join(tmpdir(), 'sbx-outer-'));
		const root = join(parent, 'inner');
		mkdirSync(root);
		chmodSync(parent, 0o755);
		await hostSandboxFiles(root).write('a/b.txt', 'x', { dirMode: 0o711 });
		expect(statSync(parent).mode & 0o777).toBe(0o755);
		rmSync(parent, { recursive: true, force: true });
	});

	it('refuses a write that would escape the root', async () => {
		const root = mkdtempSync(join(tmpdir(), 'sbx-esc-'));
		await expect(hostSandboxFiles(root).write('../outside.txt', 'x')).rejects.toThrow(/escapes/);
		rmSync(root, { recursive: true, force: true });
	});

	it('creates a directory with mkdir', async () => {
		const root = mkdtempSync(join(tmpdir(), 'sbx-mkdir-'));
		await hostSandboxFiles(root).mkdir('a/b/c', { mode: 0o711 });
		expect(statSync(join(root, 'a/b/c')).mode & 0o777).toBe(0o711);
		rmSync(root, { recursive: true, force: true });
	});
});
