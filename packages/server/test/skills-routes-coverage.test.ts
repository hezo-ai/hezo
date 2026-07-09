import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { loadAgentRoles } from '../src/db/agent-roles';
import type { Db } from '../src/db/database';
import { seedBuiltins } from '../src/db/seed';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { authHeader, createStubDocker } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

// Branch-coverage tests for packages/server/src/routes/skills.ts. Targets the
// validation guards (missing name/content/slug, empty PATCH), not-found returns,
// the LOCKED gate on registry-token writes, the FORBIDDEN gate for non-superusers,
// and the description-derivation branches in POST/PATCH.

let app: Hono<Env>;
let db: Db;
let token: string;
let nonSuperToken: string;
let masterKeyManager: MasterKeyManager;
let tempDataDir: string;

beforeAll(async () => {
	tempDataDir = join(
		tmpdir(),
		`hezo-test-skills-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db, generateUnlockKey());
	await seedBuiltins(db, await loadAgentRoles());
	app = buildApp(db, masterKeyManager, { dataDir: tempDataDir, webUrl: '' }, createStubDocker());

	const admin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Routes Admin', true) RETURNING id",
	);
	token = await signAdminJwt(masterKeyManager, admin.rows[0].id);

	const plain = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Board User', false) RETURNING id",
	);
	nonSuperToken = await signAdminJwt(masterKeyManager, plain.rows[0].id);
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await db.query('DELETE FROM skills');
});

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

function create(body: Record<string, unknown>): Promise<Response> {
	return app.request('/api/skills', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function createId(body: Record<string, unknown>): Promise<string> {
	return (await (await create(body)).json()).data.id as string;
}

describe('POST /api/skills validation guards', () => {
	it('400s when name is missing or blank', async () => {
		const res = await create({ content: 'body' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('name is required');

		const blank = await create({ name: '   ', content: 'body' });
		expect(blank.status).toBe(400);
	});

	it('400s when content is missing or blank', async () => {
		const res = await create({ name: 'No Content' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('content is required');

		const blank = await create({ name: 'Blank Content', content: '   ' });
		expect(blank.status).toBe(400);
	});

	it('400s when a slug cannot be derived from the name', async () => {
		// A name of only punctuation toSlugs to '' and no slug override is given.
		const res = await create({ name: '!!!', content: 'body' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('slug could not be derived');
	});

	it('uses an explicit slug override when provided', async () => {
		const res = await create({ name: 'My Skill', slug: 'custom-slug', content: 'body' });
		expect(res.status).toBe(201);
		expect((await res.json()).data.slug).toBe('custom-slug');
	});

	it('derives the description from content when none is given', async () => {
		const res = await create({
			name: 'Derived Desc',
			content: 'This is the first line that becomes the summary.\nMore detail follows.',
		});
		expect(res.status).toBe(201);
		const skill = (await res.json()).data as { description: string };
		expect(skill.description.length).toBeGreaterThan(0);
	});

	it('keeps an explicit description over the derived one', async () => {
		const res = await create({
			name: 'Explicit Desc',
			description: 'A clear hand-written summary',
			content: '# Body\nlots of words',
		});
		expect((await res.json()).data.description).toBe('A clear hand-written summary');
	});
});

describe('PATCH /api/skills/:id branches', () => {
	it('404s when patching a non-existent id', async () => {
		const res = await app.request(`/api/skills/${MISSING_ID}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'whatever' }),
		});
		expect(res.status).toBe(404);
	});

	it('400s when no updatable fields are supplied', async () => {
		const id = await createId({ name: 'Patchable', slug: 'patchable', content: 'v1' });
		const res = await app.request(`/api/skills/${id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('No fields to update');
	});

	it('updates name and tags only without touching content', async () => {
		const id = await createId({ name: 'Multi', slug: 'multi', content: 'original' });
		const res = await app.request(`/api/skills/${id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Renamed', tags: ['a', 'b'] }),
		});
		expect(res.status).toBe(200);
		const skill = (await res.json()).data as { name: string; tags: string[]; content: string };
		expect(skill.name).toBe('Renamed');
		expect(skill.tags).toEqual(['a', 'b']);
		expect(skill.content).toBe('original');
	});

	it('re-derives the description from new content when description is blank', async () => {
		const id = await createId({
			name: 'ReDesc',
			slug: 'redesc',
			content: 'old',
			description: 'old desc',
		});
		const res = await app.request(`/api/skills/${id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: '', content: 'A brand new opening line.' }),
		});
		expect(res.status).toBe(200);
		const skill = (await res.json()).data as { description: string; content: string };
		expect(skill.content).toBe('A brand new opening line.');
		expect(skill.description).toContain('brand new opening line');
	});

	it('sets an explicit non-empty description', async () => {
		const id = await createId({ name: 'D2', slug: 'd2', content: 'body' });
		const res = await app.request(`/api/skills/${id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'hand written' }),
		});
		expect((await res.json()).data.description).toBe('hand written');
	});
});

describe('GET/DELETE /api/skills/:id not-found branches', () => {
	it('404s reading a missing skill', async () => {
		const res = await app.request(`/api/skills/${MISSING_ID}`, { headers: authHeader(token) });
		expect(res.status).toBe(404);
	});

	it('404s deleting a missing skill', async () => {
		const res = await app.request(`/api/skills/${MISSING_ID}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('404s listing revisions for a missing skill', async () => {
		const res = await app.request(`/api/skills/${MISSING_ID}/revisions`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('404s restoring against a missing skill', async () => {
		const res = await app.request(`/api/skills/${MISSING_ID}/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(res.status).toBe(404);
	});
});

describe('authorization: non-superuser is forbidden', () => {
	const routes: Array<[string, RequestInit]> = [
		['/api/skills', { method: 'GET' }],
		['/api/skills', { method: 'POST', body: JSON.stringify({ name: 'x', content: 'y' }) }],
		['/api/skills/registry/token', { method: 'GET' }],
		['/api/skills/registry/search?q=react', { method: 'GET' }],
		['/api/skills/anything', { method: 'GET' }],
		['/api/skills/anything/revisions', { method: 'GET' }],
	];

	for (const [path, init] of routes) {
		it(`403s ${init.method} ${path} for a non-superuser`, async () => {
			const res = await app.request(path, {
				...init,
				headers: { ...authHeader(nonSuperToken), 'Content-Type': 'application/json' },
			});
			expect(res.status).toBe(403);
		});
	}
});

describe('registry token write requires an unlocked server', () => {
	it('writes the token when unlocked and reflects configured state', async () => {
		const res = await app.request('/api/skills/registry/token', {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: '' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.configured).toBe(false);
	});

	it('reports configured=false when no token is stored', async () => {
		const res = await app.request('/api/skills/registry/token', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		expect((await res.json()).data.configured).toBe(false);
	});
});

describe('registry search/install token gating', () => {
	it('400s search when no registry token is configured', async () => {
		const res = await app.request('/api/skills/registry/search?q=react', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('REGISTRY_TOKEN_REQUIRED');
	});

	it('400s install when no id is supplied', async () => {
		const res = await app.request('/api/skills/registry/install', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('id is required');
	});
});
