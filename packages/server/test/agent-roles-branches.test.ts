import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'agent-roles-branches-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.resetModules();
	vi.doUnmock('../src/db/agent-roles');
});

describe('loadBundledAgentRoles — empty-stub branch', () => {
	it('throws "bundle is empty" when the embedded JSON resolves to an empty object', async () => {
		// The ensure-bundles stub writes `{}` so the literal import resolves for
		// tsc/vite; the loader must treat that as "never generated" and throw so
		// loadAgentRoles can fall back to the filesystem walk.
		vi.doMock('../src/db/agents-bundle.json', () => ({ default: {} }));
		const { loadBundledAgentRoles } = await import('../src/db/agent-roles');
		await expect(loadBundledAgentRoles()).rejects.toThrow(/bundle is empty/i);
	});

	it('returns the embedded bundle when the import resolves to a populated object', async () => {
		vi.doMock('../src/db/agents-bundle.json', () => ({
			default: { '_instance/ceo.md': '# CEO', 'blank/captain.md': '# Captain' },
		}));
		const { loadBundledAgentRoles } = await import('../src/db/agent-roles');
		const bundle = await loadBundledAgentRoles();
		expect(bundle['_instance/ceo.md']).toBe('# CEO');
		expect(Object.keys(bundle)).toHaveLength(2);
	});

	it('throws a build-required error when the bundle import itself rejects', async () => {
		// Simulate the dev case where the JSON file is absent: the dynamic import
		// rejects, and the catch arm raises the build:agents message.
		vi.doMock('../src/db/agents-bundle.json', () => {
			throw new Error('module not found');
		});
		const { loadBundledAgentRoles } = await import('../src/db/agent-roles');
		await expect(loadBundledAgentRoles()).rejects.toThrow(/build:agents/i);
	});
});

describe('loadAgentRoles — bundle path (no HEZO_AGENTS_DIR override)', () => {
	let prev: string | undefined;
	beforeEach(() => {
		prev = process.env.HEZO_AGENTS_DIR;
		delete process.env.HEZO_AGENTS_DIR;
	});
	afterEach(() => {
		if (prev === undefined) delete process.env.HEZO_AGENTS_DIR;
		else process.env.HEZO_AGENTS_DIR = prev;
	});

	it('returns the populated bundle directly without touching the filesystem', async () => {
		// A populated bundle means loadAgentRoles takes the success branch and never
		// reaches the import.meta.url filesystem fallback.
		vi.doMock('../src/db/agents-bundle.json', () => ({
			default: { '_instance/ceo.md': '# CEO from bundle' },
		}));
		const { loadAgentRoles } = await import('../src/db/agent-roles');
		const roles = await loadAgentRoles();
		expect(roles['_instance/ceo.md']).toBe('# CEO from bundle');
	});
});

describe('loadFilesystemAgentRoles — nested recursion branch', () => {
	it('recurses through nested subdirectories (directory entry → walk)', async () => {
		const { loadFilesystemAgentRoles } = await import('../src/db/agent-roles');
		// Two levels deep exercises the isDirectory recursion arm beyond a single level.
		mkdirSync(join(root, 'a', 'b'), { recursive: true });
		writeFileSync(join(root, 'a', 'top.md'), '# Top');
		writeFileSync(join(root, 'a', 'b', 'deep.md'), '# Deep');
		// A directory with no markdown still recurses but contributes nothing.
		mkdirSync(join(root, 'empty'), { recursive: true });

		const roles = await loadFilesystemAgentRoles(root);
		expect(Object.keys(roles).sort()).toEqual(['a/b/deep.md', 'a/top.md']);
		expect(roles['a/b/deep.md']).toBe('# Deep');
	});
});
