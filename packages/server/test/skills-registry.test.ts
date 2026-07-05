import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import {
	getRegistryToken,
	hasRegistryToken,
	installRegistrySkill,
	SkillsRegistryError,
	searchRegistry,
	setRegistryToken,
} from '../src/services/skills-registry';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { authHeader, createStubDocker } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

// A minimal stand-in for the skills.sh REST API. Auth-gated like the real one,
// so the "no token" paths are exercised against a 401 rather than the internet.
const TOKEN = 'sim-token-123';
const SKILL_MD =
	'---\nname: React Hooks\ndescription: Use hooks well\n---\n# React Hooks\nAlways follow the rules of hooks.';

async function createSkillsSim(): Promise<{ baseUrl: string; destroy: () => Promise<void> }> {
	const app = new Hono();
	const authed = (h: string | undefined) => h === `Bearer ${TOKEN}`;

	app.get('/api/v1/skills/search', (c) => {
		if (!authed(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
		return c.json({
			data: [
				{
					id: 'acme/skills/react-hooks',
					slug: 'react-hooks',
					name: 'React Hooks',
					source: 'acme/skills',
					installs: 1234,
					sourceType: 'github',
					url: 'https://skills.sh/acme/skills/react-hooks',
				},
			],
			query: c.req.query('q') ?? '',
		});
	});

	app.get('/api/v1/skills/:owner/:repo/:skill', (c) => {
		if (!authed(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
		return c.json({
			id: 'acme/skills/react-hooks',
			source: 'acme/skills',
			slug: 'react-hooks',
			files: [{ path: 'SKILL.md', contents: SKILL_MD }],
		});
	});

	const server: Server = createServer(async (req, res) => {
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
		}
		const response = await app.fetch(
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

let db: Db;
let key: Buffer;
let app: Hono<Env>;
let adminToken: string;
let tempDataDir: string;
let sim: { baseUrl: string; destroy: () => Promise<void> };
const prevBaseUrl = process.env.SKILLS_REGISTRY_BASE_URL;

beforeAll(async () => {
	tempDataDir = join(
		tmpdir(),
		`hezo-test-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	const mkm = new MasterKeyManager();
	await mkm.initialize(db, generateUnlockKey());
	const k = mkm.getKey();
	if (!k) throw new Error('master key not available');
	key = k;

	app = buildApp(db, mkm, { dataDir: tempDataDir, webUrl: '' }, createStubDocker());
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Registry Admin', true) RETURNING id",
	);
	adminToken = await signAdminJwt(mkm, userResult.rows[0].id);

	sim = await createSkillsSim();
	process.env.SKILLS_REGISTRY_BASE_URL = sim.baseUrl;
});

afterAll(async () => {
	if (prevBaseUrl === undefined) delete process.env.SKILLS_REGISTRY_BASE_URL;
	else process.env.SKILLS_REGISTRY_BASE_URL = prevBaseUrl;
	await sim.destroy();
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await db.query('DELETE FROM skills');
});

describe('registry token storage', () => {
	it('stores, reads, and clears the token (encrypted at rest)', async () => {
		expect(await hasRegistryToken(db)).toBe(false);
		await setRegistryToken(db, key, TOKEN);
		expect(await hasRegistryToken(db)).toBe(true);
		expect(await getRegistryToken(db, key)).toBe(TOKEN);

		const raw = await db.query<{ value: string }>(
			"SELECT value FROM system_meta WHERE key = 'skills_registry_token'",
		);
		expect(raw.rows[0].value).not.toContain(TOKEN);

		await setRegistryToken(db, key, '   ');
		expect(await hasRegistryToken(db)).toBe(false);
	});
});

describe('searchRegistry', () => {
	it('returns mapped hits with a valid token', async () => {
		const hits = await searchRegistry(TOKEN, 'react', 5);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			id: 'acme/skills/react-hooks',
			name: 'React Hooks',
			source: 'acme/skills',
			installs: 1234,
		});
	});

	it('throws 401 when the token is missing', async () => {
		await expect(searchRegistry(null, 'react')).rejects.toMatchObject({ status: 401 });
	});

	it('rejects too-short queries before calling out', async () => {
		await expect(searchRegistry(TOKEN, 'a')).rejects.toBeInstanceOf(SkillsRegistryError);
	});
});

describe('installRegistrySkill', () => {
	it('fetches, strips frontmatter, and upserts a global skill (idempotent)', async () => {
		const res = await installRegistrySkill(db, 'acme/skills/react-hooks', TOKEN, null);
		expect(res.reused).toBe(false);
		expect(res.slug).toBe('react-hooks');

		const row = await db.query<{
			name: string;
			content: string;
			description: string;
			source_url: string;
		}>('SELECT name, content, description, source_url FROM skills WHERE slug = $1', [res.slug]);
		expect(row.rows[0].name).toBe('React Hooks');
		expect(row.rows[0].description).toBe('Use hooks well');
		expect(row.rows[0].content).toContain('Always follow the rules of hooks.');
		expect(row.rows[0].content).not.toContain('name: React Hooks'); // frontmatter stripped
		expect(row.rows[0].source_url).toContain('acme/skills/react-hooks');

		const again = await installRegistrySkill(db, 'acme/skills/react-hooks', TOKEN, null);
		expect(again.reused).toBe(true);
	});

	it('rejects a malformed skill id', async () => {
		await expect(installRegistrySkill(db, 'not-an-id', TOKEN, null)).rejects.toBeInstanceOf(
			SkillsRegistryError,
		);
	});
});

describe('registry routes (HTTP)', () => {
	function req(path: string, init?: RequestInit) {
		return app.request(`/api/skills${path}`, {
			...init,
			headers: {
				...authHeader(adminToken),
				'Content-Type': 'application/json',
				...(init?.headers ?? {}),
			},
		});
	}

	it('gates search on a configured token', async () => {
		await setRegistryToken(db, key, '');
		const status = await req('/registry/token');
		expect((await status.json()).data.configured).toBe(false);

		const search = await req('/registry/search?q=react');
		expect(search.status).toBe(400);
		expect((await search.json()).error.code).toBe('REGISTRY_TOKEN_REQUIRED');
	});

	it('sets the token, then searches and installs straight from a result', async () => {
		const put = await req('/registry/token', {
			method: 'PUT',
			body: JSON.stringify({ token: TOKEN }),
		});
		expect(put.status).toBe(200);
		expect((await put.json()).data.configured).toBe(true);

		const search = await req('/registry/search?q=react');
		expect(search.status).toBe(200);
		const hits = (await search.json()).data as Array<{ id: string }>;
		expect(hits[0].id).toBe('acme/skills/react-hooks');

		const install = await req('/registry/install', {
			method: 'POST',
			body: JSON.stringify({ id: hits[0].id }),
		});
		expect(install.status).toBe(201);

		const list = await req('');
		const slugs = ((await list.json()).data as Array<{ slug: string }>).map((s) => s.slug);
		expect(slugs).toContain('react-hooks');
	});
});
