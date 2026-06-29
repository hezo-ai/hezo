import { createServer, type Server } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { setSystemMeta } from '../src/lib/system-meta';
import {
	getRegistryToken,
	hasRegistryToken,
	installRegistrySkill,
	SkillsRegistryError,
	searchRegistry,
	setRegistryToken,
} from '../src/services/skills-registry';
import { safeClose } from './helpers';
import { createTestDbWithMigrations } from './helpers/db';

// Branch-coverage tests for packages/server/src/services/skills-registry.ts.
// Exercises token storage edge cases (decrypt failure), search mapping/limit/error
// branches, and the install path's malformed-id and slug-derivation guards. A
// configurable in-process stand-in for skills.sh drives the various HTTP shapes
// without touching the network.

const TOKEN = 'sim-token-xyz';

// Mutable knobs the sim reads per request so a single server can drive every
// branch (auth failure, non-ok, malformed body, missing SKILL.md).
const sim = {
	searchStatus: 200,
	searchBody: undefined as unknown,
	skillStatus: 200,
	skillBody: undefined as unknown,
	lastSearchUrl: '',
};

async function createSim(): Promise<{ baseUrl: string; destroy: () => Promise<void> }> {
	const a = new Hono();
	a.get('/api/v1/skills/search', (c) => {
		sim.lastSearchUrl = c.req.url;
		return c.json((sim.searchBody ?? { data: [] }) as object, sim.searchStatus as 200);
	});
	a.get('/api/v1/skills/:owner/:repo/:skill', (c) => {
		return c.json((sim.skillBody ?? {}) as object, sim.skillStatus as 200);
	});

	const server: Server = createServer(async (req, res) => {
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
		}
		const response = await a.fetch(
			new Request(`http://localhost${req.url}`, { method: req.method, headers }),
		);
		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		res.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	return {
		baseUrl: `http://localhost:${port}`,
		destroy: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

let db: PGlite;
let key: Buffer;
let server: { baseUrl: string; destroy: () => Promise<void> };
const prevBaseUrl = process.env.SKILLS_REGISTRY_BASE_URL;

beforeAll(async () => {
	db = await createTestDbWithMigrations();
	const mkm = new MasterKeyManager();
	await mkm.initialize(db, generateUnlockKey());
	const k = mkm.getKey();
	if (!k) throw new Error('master key not available');
	key = k;
	server = await createSim();
	process.env.SKILLS_REGISTRY_BASE_URL = server.baseUrl;
});

afterAll(async () => {
	if (prevBaseUrl === undefined) delete process.env.SKILLS_REGISTRY_BASE_URL;
	else process.env.SKILLS_REGISTRY_BASE_URL = prevBaseUrl;
	await server.destroy();
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM skills');
	sim.searchStatus = 200;
	sim.searchBody = undefined;
	sim.skillStatus = 200;
	sim.skillBody = undefined;
});

describe('token storage', () => {
	it('getRegistryToken returns null when nothing is stored', async () => {
		await setRegistryToken(db, key, '');
		expect(await getRegistryToken(db, key)).toBeNull();
		expect(await hasRegistryToken(db)).toBe(false);
	});

	it('getRegistryToken returns null when the stored ciphertext cannot be decrypted', async () => {
		// Store a value that is present but not valid ciphertext for this key — the
		// decrypt() throws and the function swallows it, returning null.
		await setSystemMeta(db, 'skills_registry_token', 'not-real-ciphertext');
		expect(await hasRegistryToken(db)).toBe(true); // present...
		expect(await getRegistryToken(db, key)).toBeNull(); // ...but undecryptable
	});

	it('setRegistryToken trims whitespace-only tokens to a clear', async () => {
		await setRegistryToken(db, key, TOKEN);
		expect(await hasRegistryToken(db)).toBe(true);
		await setRegistryToken(db, key, '   \n  ');
		expect(await hasRegistryToken(db)).toBe(false);
	});
});

describe('searchRegistry', () => {
	it('rejects queries shorter than two characters without calling out', async () => {
		await expect(searchRegistry(TOKEN, 'a')).rejects.toMatchObject({ status: 400 });
		await expect(searchRegistry(TOKEN, '  x ')).rejects.toBeInstanceOf(SkillsRegistryError);
	});

	it('clamps the limit into the 1..50 range', async () => {
		sim.searchBody = { data: [] };
		await searchRegistry(TOKEN, 'react', 9999);
		expect(sim.lastSearchUrl).toContain('limit=50');

		await searchRegistry(TOKEN, 'react', -5);
		expect(sim.lastSearchUrl).toContain('limit=1');

		await searchRegistry(TOKEN, 'react', Number.NaN);
		expect(sim.lastSearchUrl).toContain('limit=20'); // NaN -> default 20
	});

	it('throws 401 when the registry rejects the token', async () => {
		sim.searchStatus = 403;
		sim.searchBody = { error: 'forbidden' };
		await expect(searchRegistry(TOKEN, 'react')).rejects.toMatchObject({ status: 401 });
	});

	it('throws 502 on a non-ok, non-auth status', async () => {
		sim.searchStatus = 500;
		sim.searchBody = { error: 'boom' };
		await expect(searchRegistry(TOKEN, 'react')).rejects.toMatchObject({ status: 502 });
	});

	it('returns an empty list when data is not an array', async () => {
		sim.searchBody = { data: 'not-an-array' };
		expect(await searchRegistry(TOKEN, 'react')).toEqual([]);
	});

	it('maps rows, falls back across name fields, and drops rows without an id', async () => {
		sim.searchBody = {
			data: [
				{ id: 'a/b/c', slug: 'c', source: 'a/b', installs: 7, url: 'http://x' },
				{ id: 'd/e/f', installs: 'bad' }, // no name/slug -> name falls back to id; installs -> 0
				{ slug: 'no-id' }, // dropped — no id
			],
		};
		const hits = await searchRegistry(TOKEN, 'react');
		expect(hits).toHaveLength(2);
		expect(hits[0]).toMatchObject({ id: 'a/b/c', name: 'c', installs: 7 });
		// name falls back to slug then id when absent; installs of 'bad' -> 0.
		expect(hits[1]).toMatchObject({ id: 'd/e/f', name: 'd/e/f', installs: 0 });
	});

	it('surfaces a network failure as a 502 SkillsRegistryError', async () => {
		const prev = process.env.SKILLS_REGISTRY_BASE_URL;
		// Point at a closed port to force a connection error.
		process.env.SKILLS_REGISTRY_BASE_URL = 'http://127.0.0.1:1';
		try {
			await expect(searchRegistry(TOKEN, 'react')).rejects.toMatchObject({
				status: 502,
			});
		} finally {
			process.env.SKILLS_REGISTRY_BASE_URL = prev;
		}
	});
});

describe('installRegistrySkill', () => {
	it('rejects a malformed skill id (not owner/repo/skill)', async () => {
		await expect(installRegistrySkill(db, 'not-an-id', TOKEN, null)).rejects.toMatchObject({
			status: 400,
		});
	});

	it('throws 401 when the registry rejects the token for a single skill fetch', async () => {
		sim.skillStatus = 401;
		sim.skillBody = { error: 'unauthorized' };
		await expect(
			installRegistrySkill(db, 'acme/skills/react-hooks', TOKEN, null),
		).rejects.toMatchObject({ status: 401 });
	});

	it('fetches, parses frontmatter, and upserts; idempotent on re-install', async () => {
		sim.skillBody = {
			files: [
				{
					path: 'skills/react-hooks/SKILL.md',
					contents:
						'---\nname: React Hooks\ndescription: Use hooks well\n---\n# React Hooks\nFollow the rules.',
				},
			],
		};
		const first = await installRegistrySkill(db, 'acme/skills/react-hooks', TOKEN, null);
		expect(first.reused).toBe(false);
		expect(first.slug).toBe('react-hooks');

		const row = await db.query<{ name: string; description: string; content: string }>(
			'SELECT name, description, content FROM skills WHERE slug = $1',
			[first.slug],
		);
		expect(row.rows[0].name).toBe('React Hooks');
		expect(row.rows[0].description).toBe('Use hooks well');
		expect(row.rows[0].content).not.toContain('name: React Hooks');

		const again = await installRegistrySkill(db, 'acme/skills/react-hooks', TOKEN, null);
		expect(again.reused).toBe(true);
	});

	it('derives name and description from content when frontmatter omits them', async () => {
		sim.skillBody = {
			files: [{ path: 'SKILL.md', contents: '# Just a body\nNo frontmatter at all here.' }],
		};
		const res = await installRegistrySkill(db, 'acme/skills/plainskill', TOKEN, null);
		// slug falls back to the skill segment of the id.
		expect(res.slug).toBe('plainskill');
		expect(res.name).toBe('plainskill'); // name falls back to slug
		const row = await db.query<{ description: string }>(
			'SELECT description FROM skills WHERE slug = $1',
			[res.slug],
		);
		expect(row.rows[0].description.length).toBeGreaterThan(0);
	});
});
