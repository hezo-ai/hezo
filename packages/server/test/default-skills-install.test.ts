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
	listDefaultSkillStatus,
	listMissingDefaultSkills,
	loadDefaultSkills,
	refreshDefaultSkills,
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
		updated_at: string;
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
		expect(missing.length).toBe(16);
		expect(missing.find((m) => m.slug === 'code-review')).toBeDefined();

		const install = await app.request('/api/skills/defaults/install', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(install.status).toBe(200);
		const installed = (await install.json()).data.installed as Array<{ slug: string }>;
		expect(installed.length).toBe(16);

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
		expect(missing.length).toBe(15);
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
		expect(installed.length).toBe(16);
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

/**
 * Drift: the shipped body changed after this instance installed it. The marker
 * holds the hash installed here, so `marker != shipped` is drift and
 * `row != marker` is the operator's own edit on top of it.
 */
describe('listDefaultSkillStatus - outdated defaults', () => {
	async function install(slug: string, content: string) {
		await installDefaultSkills(db, { defs: [def(slug, content)] });
	}

	it('reports an installed default as outdated once the shipped body changes', async () => {
		await install('alpha', '# A v1');
		const { missing, outdated } = await listDefaultSkillStatus(db, [def('alpha', '# A v2')]);
		expect(missing).toEqual([]);
		expect(outdated).toEqual([
			{
				slug: 'alpha',
				name: 'Skill alpha',
				description: 'Description for alpha',
				locally_edited: false,
			},
		]);
	});

	it('flags an operator-edited skill so the refresh can confirm separately', async () => {
		await install('alpha', '# A v1');
		const row = await getGlobalSkill('alpha');
		await db.query('UPDATE skills SET content = $1, content_hash = $2 WHERE id = $3', [
			'# mine',
			createHash('sha256').update('# mine').digest('hex'),
			row.id,
		]);
		const { outdated } = await listDefaultSkillStatus(db, [def('alpha', '# A v2')]);
		expect(outdated).toMatchObject([{ slug: 'alpha', locally_edited: true }]);
	});

	it('says nothing about a default that is installed and already current', async () => {
		await install('alpha', '# A v1');
		const status = await listDefaultSkillStatus(db, [def('alpha', '# A v1')]);
		expect(status).toEqual({ missing: [], outdated: [] });
	});

	it('leaves a deleted default alone even after the shipped body changes', async () => {
		await install('alpha', '# A v1');
		await db.query('DELETE FROM skills WHERE slug = $1', ['alpha']);
		const status = await listDefaultSkillStatus(db, [def('alpha', '# A v2')]);
		expect(status).toEqual({ missing: [], outdated: [] });
	});

	it('never claims a same-slug skill this instance did not install', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, description, content, content_hash, tags, project_id)
			 VALUES ('Mine', 'alpha', '', 'user', 'h', '[]'::jsonb, NULL)`,
		);
		const status = await listDefaultSkillStatus(db, [def('alpha', '# A v2')]);
		expect(status).toEqual({ missing: [], outdated: [] });
	});

	it('skips a row that already matches the new shipped body', async () => {
		await install('alpha', '# A v1');
		const row = await getGlobalSkill('alpha');
		await db.query('UPDATE skills SET content = $1, content_hash = $2 WHERE id = $3', [
			'# A v2',
			createHash('sha256').update('# A v2').digest('hex'),
			row.id,
		]);
		const { outdated } = await listDefaultSkillStatus(db, [def('alpha', '# A v2')]);
		expect(outdated).toEqual([]);
	});
});

describe('refreshDefaultSkills', () => {
	it('rewrites the body, keeps the prior content as a revision, and clears the drift', async () => {
		await installDefaultSkills(db, { defs: [def('alpha', '# A v1')] });
		const next = def('alpha', '# A v2', 'Skill alpha renamed');

		const refreshed = await refreshDefaultSkills(db, { defs: [next] });
		expect(refreshed).toEqual([
			{ id: expect.any(String), slug: 'alpha', name: 'Skill alpha renamed' },
		]);

		const row = await getGlobalSkill('alpha');
		expect(row.content).toBe('# A v2');
		expect(row.content_hash).toBe(next.contentHash);

		const revisions = await db.query<{ content: string }>(
			'SELECT content FROM skill_revisions WHERE skill_id = $1 ORDER BY revision_number',
			[row.id],
		);
		expect(revisions.rows.map((r) => r.content)).toEqual(['# A v1']);

		expect(await getSystemMeta(db, `${DEFAULT_SKILL_MARKER_PREFIX}alpha`)).toBe(next.contentHash);
		expect((await listDefaultSkillStatus(db, [next])).outdated).toEqual([]);
	});

	it('overwrites an operator edit but leaves it restorable from the revision', async () => {
		await installDefaultSkills(db, { defs: [def('alpha', '# A v1')] });
		const row = await getGlobalSkill('alpha');
		await db.query('UPDATE skills SET content = $1, content_hash = $2 WHERE id = $3', [
			'# mine',
			createHash('sha256').update('# mine').digest('hex'),
			row.id,
		]);

		await refreshDefaultSkills(db, { defs: [def('alpha', '# A v2')] });

		expect((await getGlobalSkill('alpha')).content).toBe('# A v2');
		const revisions = await db.query<{ content: string }>(
			'SELECT content FROM skill_revisions WHERE skill_id = $1 ORDER BY revision_number',
			[row.id],
		);
		expect(revisions.rows.map((r) => r.content)).toEqual(['# mine']);
	});

	it('refreshes only the confirmed subset when slugs are passed', async () => {
		await installDefaultSkills(db, { defs: [def('alpha', '# A v1'), def('beta', '# B v1')] });
		const next = [def('alpha', '# A v2'), def('beta', '# B v2')];

		const refreshed = await refreshDefaultSkills(db, { defs: next, slugs: ['alpha'] });
		expect(refreshed.map((r) => r.slug)).toEqual(['alpha']);
		expect((await getGlobalSkill('beta')).content).toBe('# B v1');
		expect((await listDefaultSkillStatus(db, next)).outdated.map((o) => o.slug)).toEqual(['beta']);
	});

	it('writes nothing when no default has drifted', async () => {
		await installDefaultSkills(db, { defs: [def('alpha', '# A v1')] });
		const before = await getGlobalSkill('alpha');

		expect(await refreshDefaultSkills(db, { defs: [def('alpha', '# A v1')] })).toEqual([]);

		const after = await getGlobalSkill('alpha');
		expect(after.updated_at).toEqual(before.updated_at);
		const revisions = await db.query('SELECT 1 FROM skill_revisions WHERE skill_id = $1', [
			before.id,
		]);
		expect(revisions.rows).toEqual([]);
	});

	it('does not resurrect a default the operator deleted', async () => {
		await installDefaultSkills(db, { defs: [def('alpha', '# A v1')] });
		await db.query('DELETE FROM skills WHERE slug = $1', ['alpha']);

		expect(await refreshDefaultSkills(db, { defs: [def('alpha', '# A v2')] })).toEqual([]);
		expect(await getGlobalSkill('alpha')).toBeUndefined();
	});
});

describe('default-skills refresh route', () => {
	it('reports drift over the API and refreshes behind a POST', async () => {
		await installDefaultSkills(db, { defs: [def('alpha', '# A v1')] });
		// The route reads the real catalog, so drive drift through the marker the
		// same way an upgrade does: the shipped body has moved on from what the
		// marker recorded at install time.
		await setSystemMeta(db, `${DEFAULT_SKILL_MARKER_PREFIX}code-review`, 'stale-hash');
		await db.query(
			`INSERT INTO skills (name, slug, description, content, content_hash, tags, project_id)
			 VALUES ('Code Review', 'code-review', '', 'old body', 'stale-hash', '[]'::jsonb, NULL)`,
		);

		const listed = await app.request('/api/skills/defaults', { headers: authHeader(token) });
		const body = (await listed.json()).data as {
			missing: Array<{ slug: string }>;
			outdated: Array<{ slug: string; locally_edited: boolean }>;
		};
		expect(body.outdated).toMatchObject([{ slug: 'code-review', locally_edited: false }]);

		const res = await app.request('/api/skills/defaults/refresh', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ slugs: ['code-review'] }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.refreshed).toMatchObject([{ slug: 'code-review' }]);
		expect((await getGlobalSkill('code-review')).content).not.toBe('old body');

		const after = await app.request('/api/skills/defaults', { headers: authHeader(token) });
		expect((await after.json()).data.outdated).toEqual([]);
	});

	it('rejects a non-admin caller', async () => {
		const res = await app.request('/api/skills/defaults/refresh', { method: 'POST' });
		expect(res.status).toBe(401);
	});
});

describe('bundled default catalog wiring', () => {
	it('loadDefaultSkills feeds listMissingDefaultSkills with the real 16', async () => {
		const missing = await listMissingDefaultSkills(db, await loadDefaultSkills());
		expect(missing.length).toBe(16);
	});
});
