import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	buildHezoDocsBlock,
	loadDocs,
	loadFilesystemDocs,
	resetDocsBlockCache,
} from '../src/services/docs-bundle';

// Covers the filesystem-walk paths (loadFilesystemDocs / loadDocs via
// HEZO_DOCS_DIR) and the cache reset, which the bundled-import test never hits.

let docsDir: string;
const realDocsDirEnv = process.env.HEZO_DOCS_DIR;

beforeEach(() => {
	docsDir = mkdtempSync(join(tmpdir(), 'hezo-docs-test-'));
});

afterEach(() => {
	rmSync(docsDir, { recursive: true, force: true });
	if (realDocsDirEnv === undefined) delete process.env.HEZO_DOCS_DIR;
	else process.env.HEZO_DOCS_DIR = realDocsDirEnv;
	resetDocsBlockCache();
});

describe('loadFilesystemDocs', () => {
	it('walks nested directories and keys docs by posix-relative path', async () => {
		writeFileSync(join(docsDir, 'intro.md'), '---\ntitle: Intro\n---\nbody');
		mkdirSync(join(docsDir, 'guide'), { recursive: true });
		writeFileSync(join(docsDir, 'guide', 'setup.md'), '---\ntitle: Setup\n---\nsetup body');
		// Non-markdown files are ignored.
		writeFileSync(join(docsDir, 'ignore.txt'), 'not markdown');

		const docs = await loadFilesystemDocs(docsDir);
		expect(Object.keys(docs).sort()).toEqual(['guide/setup.md', 'intro.md']);
		expect(docs['intro.md']).toContain('body');
		expect(docs['guide/setup.md']).toContain('setup body');
	});

	it('returns an empty map for a directory with no markdown', async () => {
		writeFileSync(join(docsDir, 'readme.txt'), 'nope');
		const docs = await loadFilesystemDocs(docsDir);
		expect(docs).toEqual({});
	});
});

describe('loadDocs via HEZO_DOCS_DIR', () => {
	it('reads from the override directory instead of the bundle', async () => {
		writeFileSync(
			join(docsDir, 'a.md'),
			'---\ntitle: Alpha\norder: 1\nsection: S\n---\nalpha body',
		);
		process.env.HEZO_DOCS_DIR = docsDir;
		const docs = await loadDocs();
		expect(docs['a.md']).toContain('alpha body');
	});
});

describe('buildHezoDocsBlock with overridden docs dir + cache reset', () => {
	it('builds the block from the filesystem docs and caches it', async () => {
		writeFileSync(
			join(docsDir, 'first.md'),
			'---\ntitle: First Doc\norder: 1\nsection: Alpha\n---\nfirst content',
		);
		writeFileSync(
			join(docsDir, 'second.md'),
			'---\ntitle: Second Doc\norder: 2\nsection: Alpha\n---\nsecond content',
		);
		process.env.HEZO_DOCS_DIR = docsDir;
		resetDocsBlockCache();

		const block = await buildHezoDocsBlock();
		expect(block.startsWith('# Hezo documentation')).toBe(true);
		expect(block).toContain('## Alpha');
		expect(block).toContain('### First Doc');
		expect(block).toContain('first content');
		// order: First (1) precedes Second (2).
		expect(block.indexOf('First Doc')).toBeLessThan(block.indexOf('Second Doc'));

		// Second call returns the cached value (same dir, identical output).
		const again = await buildHezoDocsBlock();
		expect(again).toBe(block);
	});

	it('resetDocsBlockCache lets a different docs dir take effect', async () => {
		writeFileSync(join(docsDir, 'only.md'), '---\ntitle: OnlyOne\norder: 1\n---\noriginal');
		process.env.HEZO_DOCS_DIR = docsDir;
		resetDocsBlockCache();
		const first = await buildHezoDocsBlock();
		expect(first).toContain('OnlyOne');

		const dir2 = mkdtempSync(join(tmpdir(), 'hezo-docs-test2-'));
		try {
			writeFileSync(join(dir2, 'other.md'), '---\ntitle: Different\norder: 1\n---\nfresh');
			process.env.HEZO_DOCS_DIR = dir2;
			resetDocsBlockCache();
			const second = await buildHezoDocsBlock();
			expect(second).toContain('Different');
			expect(second).not.toContain('OnlyOne');
		} finally {
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});
