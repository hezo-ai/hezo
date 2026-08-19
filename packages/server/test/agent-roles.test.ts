import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	loadAgentRoles,
	loadBundledAgentRoles,
	loadFilesystemAgentRoles,
} from '../src/db/agent-roles';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'agent-roles-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('loadFilesystemAgentRoles', () => {
	it('recursively walks a directory, keying each .md by its relative posix path', async () => {
		mkdirSync(join(root, 'app-dev'), { recursive: true });
		mkdirSync(join(root, 'blank'), { recursive: true });
		writeFileSync(join(root, 'app-dev', 'engineer.md'), '# Engineer');
		writeFileSync(join(root, 'app-dev', 'qa.md'), '# QA');
		writeFileSync(join(root, 'blank', 'captain.md'), '# Captain');
		// Non-markdown files are ignored.
		writeFileSync(join(root, 'README.txt'), 'ignore me');

		const roles = await loadFilesystemAgentRoles(root);
		expect(Object.keys(roles).sort()).toEqual([
			'app-dev/engineer.md',
			'app-dev/qa.md',
			'blank/captain.md',
		]);
		expect(roles['app-dev/engineer.md']).toBe('# Engineer');
		expect(roles['blank/captain.md']).toBe('# Captain');
	});

	it('returns an empty map for an empty directory', async () => {
		const roles = await loadFilesystemAgentRoles(root);
		expect(roles).toEqual({});
	});
});

describe('loadAgentRoles (HEZO_AGENTS_DIR override + partial resolution)', () => {
	let prev: string | undefined;

	beforeEach(() => {
		prev = process.env.HEZO_AGENTS_DIR;
	});

	afterEach(() => {
		if (prev === undefined) delete process.env.HEZO_AGENTS_DIR;
		else process.env.HEZO_AGENTS_DIR = prev;
	});

	it('loads from HEZO_AGENTS_DIR and resolves {{> partials/...}} includes', async () => {
		mkdirSync(join(root, '_partials'), { recursive: true });
		mkdirSync(join(root, 'team'), { recursive: true });
		writeFileSync(join(root, '_partials', 'shared.md'), 'SHARED BLOCK');
		writeFileSync(join(root, 'team', 'lead.md'), '# Lead\n{{> partials/shared}}\nend');

		process.env.HEZO_AGENTS_DIR = root;
		const roles = await loadAgentRoles();

		// The partial file itself is not surfaced as a role.
		expect(roles['_partials/shared.md']).toBeUndefined();
		// The directive was expanded inline.
		expect(roles['team/lead.md']).toBe('# Lead\nSHARED BLOCK\nend');
	});

	it('throws a clear error when a partial reference is unknown', async () => {
		mkdirSync(join(root, 'team'), { recursive: true });
		writeFileSync(join(root, 'team', 'lead.md'), '{{> partials/does-not-exist}}');
		process.env.HEZO_AGENTS_DIR = root;
		await expect(loadAgentRoles()).rejects.toThrow(/Unknown partial reference/);
	});

	it('loads built-in roles via the bundle/fallback when no override is set', async () => {
		// No HEZO_AGENTS_DIR → loadAgentRoles goes through loadBundledAgentRoles,
		// falling back to the filesystem walk of the repo `agents/` dir if the
		// bundle is an empty stub. Either way the seeded built-ins (CEO, Captain)
		// must resolve, since createTestApp depends on them.
		delete process.env.HEZO_AGENTS_DIR;
		const roles = await loadAgentRoles();
		expect(Object.keys(roles).length).toBeGreaterThan(0);
		expect(roles['_instance/ceo.md']).toBeTruthy();
	});
});

describe('loadBundledAgentRoles', () => {
	it('either returns the embedded bundle or throws a build-required error', async () => {
		// In a built workspace the bundle is populated; without `bun run build:agents`
		// it is an empty stub and the loader throws so loadAgentRoles can fall back.
		try {
			const bundle = await loadBundledAgentRoles();
			expect(Object.keys(bundle).length).toBeGreaterThan(0);
			expect(typeof bundle['_instance/ceo.md']).toBe('string');
		} catch (e) {
			expect((e as Error).message).toMatch(/bundle (is empty|)|build:agents/i);
		}
	});
});
