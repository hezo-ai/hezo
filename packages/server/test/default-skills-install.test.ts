import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { loadAgentRoles } from '../src/db/agent-roles';
import type { Db } from '../src/db/database';
import {
	DEFAULT_SKILL_MARKER_PREFIX,
	type DefaultSkillDef,
	installDefaultSkills,
	installDefaultSkillsIfFreshInstance,
	listMissingDefaultSkills,
	loadDefaultSkills,
} from '../src/db/default-skills';
import { seedBuiltins } from '../src/db/seed';
import { getSystemMeta, setSystemMeta } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { authHeader, createStubDocker } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

let app: Hono<Env>;
let db: Db;
let token: string;
let tempDataDir: string;

function def(slug: string, content: string, name?: string): DefaultSkillDef {
	return {
		slug,
		name: name ?? `Skill ${slug}`,
		description: `Description for ${slug}`,
		sourceUrl: null,
		content,
		contentHash: createHash('sha256').update(content).digest('hex'),
	};
}

async function getGlobalSkill(slug: string) {
	const r = await db.query<{
		id: string;
		content: string;
		content_hash: string;
		tags: string[];
		created_by_member_id: string | null;
		project_id: string | null;
	}>('SELECT * FROM skills WHERE slug = $1 AND project_id IS NULL', [slug]);
	return r.rows[0];
}

beforeAll(async () => {
	tempDataDir = join(tmpdir(), `hezo-test-default-install-${Date.now()}`);
	mkdirSync(tempDataDir, { recursive: true });
	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db, generateUnlockKey());
	await seedBuiltins(db, await loadAgentRoles());
	app = buildApp(db, masterKeyManager, { dataDir: tempDataDir, webUrl: '' }, createStubDocker());
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Install Admin', true) RETURNING id",
	);
	token = await signAdminJwt(masterKeyManager, userResult.rows[0].id);
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await db.query('DELETE FROM skills');
	await db.query('DELETE FROM system_meta WHERE key LIKE $1', [`${DEFAULT_SKILL_MARKER_PREFIX}%`]);
});

describe('listMissingDefaultSkills', () => {
	it('reports every default as missing on a fresh instance', async () => {
		const defs = [def('alpha', '# A'), def('beta', '# B')];
		const missing = await listMissingDefaultSkills(db, defs);
		expect(missing.map((m) => m.slug)).toEqual(['alpha', 'beta']);
		expect(missing[0]).toMatchObject({ slug: 'alpha', name: 'Skill alpha' });
	});

	it('excludes a default whose slug is already a global skill', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, description, content, content_hash, tags, project_id)
			 VALUES ('Mine', 'alpha', '', 'user', 'h', '[]'::jsonb, NULL)`,
		);
		const missing = await listMissingDefaultSkills(db, [def('alpha', '# A'), def('beta', '# B')]);
		expect(missing.map((m) => m.slug)).toEqual(['beta']);
	});

	it('excludes a default marked handled even after it was deleted', async () => {
		await setSystemMeta(db, `${DEFAULT_SKILL_MARKER_PREFIX}alpha`, 'somehash');
		const missing = await listMissingDefaultSkills(db, [def('alpha', '# A'), def('beta', '# B')]);
		expect(missing.map((m) => m.slug)).toEqual(['beta']);
	});
});

describe('installDefaultSkills', () => {
	it('installs all missing defaults as ordinary global rows and marks them', async () => {
		const defs = [def('alpha', '# A'), def('beta', '# B')];
		const installed = await installDefaultSkills(db, { defs });
		expect(installed.map((s) => s.slug).sort()).toEqual(['alpha', 'beta']);

		const alpha = await getGlobalSkill('alpha');
		expect(alpha.project_id).toBeNull();
		expect(alpha.created_by_member_id).toBeNull();
		expect(alpha.tags).toEqual([]);
		expect(alpha.content).toBe('# A');
		expect(await getSystemMeta(db, `${DEFAULT_SKILL_MARKER_PREFIX}alpha`)).toBe(
			defs[0].contentHash,
		);

		// Nothing missing after install; a second call is a no-op.
		expect(await listMissingDefaultSkills(db, defs)).toEqual([]);
		expect(await installDefaultSkills(db, { defs })).toEqual([]);
	});

	it('installs only the requested subset', async () => {
		const defs = [def('alpha', '# A'), def('beta', '# B'), def('gamma', '# G')];
		const installed = await installDefaultSkills(db, { defs, slugs: ['beta'] });
		expect(installed.map((s) => s.slug)).toEqual(['beta']);
		expect((await listMissingDefaultSkills(db, defs)).map((m) => m.slug)).toEqual([
			'alpha',
			'gamma',
		]);
	});

	it('does not clobber a user-authored skill occupying a default slug', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, description, content, content_hash, tags, project_id)
			 VALUES ('Mine', 'alpha', '', 'user content', 'h', '[]'::jsonb, NULL)`,
		);
		const installed = await installDefaultSkills(db, { defs: [def('alpha', '# A')] });
		expect(installed).toEqual([]);
		expect((await getGlobalSkill('alpha')).content).toBe('user content');
	});

	it('does not re-install a default the operator installed then deleted', async () => {
		const defs = [def('alpha', '# A')];
		await installDefaultSkills(db, { defs });
		await db.query('DELETE FROM skills WHERE slug = $1', ['alpha']);
		expect(await listMissingDefaultSkills(db, defs)).toEqual([]);
		expect(await installDefaultSkills(db, { defs })).toEqual([]);
		expect(await getGlobalSkill('alpha')).toBeUndefined();
	});
});

describe('default-skills routes', () => {
	it('lists missing real defaults, installs them, then reports none missing', async () => {
		const before = await app.request('/api/skills/defaults', { headers: authHeader(token) });
		expect(before.status).toBe(200);
		const missing = (await before.json()).data.missing as Array<{ slug: string; name: string }>;
		expect(missing.length).toBe(15);
		expect(missing.find((m) => m.slug === 'code-review')).toBeDefined();

		const install = await app.request('/api/skills/defaults/install', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(install.status).toBe(200);
		const installed = (await install.json()).data.installed as Array<{ slug: string }>;
		expect(installed.length).toBe(15);

		const after = await app.request('/api/skills/defaults', { headers: authHeader(token) });
		expect((await after.json()).data.missing).toEqual([]);

		// The installed skills are ordinary editable rows in the catalog.
		const list = (await (await app.request('/api/skills', { headers: authHeader(token) })).json())
			.data as Array<{ slug: string; readonly?: boolean }>;
		const cr = list.find((s) => s.slug === 'code-review');
		expect(cr?.readonly).toBe(false);
	});

	it('installs only the confirmed subset when slugs are passed', async () => {
		const install = await app.request('/api/skills/defaults/install', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ slugs: ['deep-research'] }),
		});
		expect(install.status).toBe(200);
		const installed = (await install.json()).data.installed as Array<{ slug: string }>;
		expect(installed).toEqual([
			{ id: expect.any(String), slug: 'deep-research', name: 'Deep Research' },
		]);

		const missing = (
			await (await app.request('/api/skills/defaults', { headers: authHeader(token) })).json()
		).data.missing as Array<{ slug: string }>;
		expect(missing.length).toBe(14);
		expect(missing.find((m) => m.slug === 'deep-research')).toBeUndefined();
	});

	it('rejects a non-admin caller', async () => {
		const res = await app.request('/api/skills/defaults');
		expect(res.status).toBe(401);
	});
});

describe('installDefaultSkillsIfFreshInstance', () => {
	it('installs the full catalog on a fresh instance (no HQ team yet)', async () => {
		const installed = await installDefaultSkillsIfFreshInstance(db);
		expect(installed.length).toBe(15);
		expect(await getGlobalSkill('code-review')).toBeDefined();
	});

	it('is a no-op once the HQ team exists (an existing instance)', async () => {
		await db.query(
			`INSERT INTO teams (id, name, slug, description, summary) VALUES ($1, 'HQ', 'hq', '', '')`,
			[DEFAULT_TEAM_ID],
		);
		try {
			const installed = await installDefaultSkillsIfFreshInstance(db);
			expect(installed).toEqual([]);
			expect(await getGlobalSkill('code-review')).toBeUndefined();
		} finally {
			await db.query('DELETE FROM teams WHERE id = $1', [DEFAULT_TEAM_ID]);
		}
	});
});

describe('bundled default catalog wiring', () => {
	it('loadDefaultSkills feeds listMissingDefaultSkills with the real 15', async () => {
		const missing = await listMissingDefaultSkills(db, await loadDefaultSkills());
		expect(missing.length).toBe(15);
	});
});
