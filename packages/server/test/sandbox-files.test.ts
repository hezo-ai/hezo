import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
