import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { loadAgentRoles } from '../src/db/agent-roles';
import type { Db } from '../src/db/database';
import { type DefaultSkillDef, loadDefaultSkills } from '../src/db/default-skills';
import { seedBuiltins } from '../src/db/seed';
import {
	DEFAULT_SKILL_MARKER_PREFIX,
	FOREIGN_MARKER,
	seedDefaultSkills,
} from '../src/db/seed-default-skills';
import { getSystemMeta } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectId: string;
let tempDataDir: string;

function def(
	slug: string,
	content: string,
	overrides: Partial<DefaultSkillDef> = {},
): DefaultSkillDef {
	return {
		slug,
		name: overrides.name ?? `Skill ${slug}`,
		description: overrides.description ?? `Description for ${slug}`,
		sourceUrl: overrides.sourceUrl ?? null,
		content,
		contentHash: createHash('sha256').update(content).digest('hex'),
	};
}

async function getSkill(slug: string) {
	const r = await db.query<{
		id: string;
		name: string;
		description: string;
		content: string;
		content_hash: string;
		source_url: string | null;
		tags: string[];
		is_active: boolean;
		project_id: string | null;
		created_by_member_id: string | null;
		updated_at: string;
	}>('SELECT * FROM skills WHERE slug = $1 AND project_id IS NULL', [slug]);
	return r.rows[0];
}

async function getRevisions(skillId: string) {
	const r = await db.query<{
		content: string;
		change_summary: string;
		author_member_id: string | null;
	}>(
		'SELECT content, change_summary, author_member_id FROM skill_revisions WHERE skill_id = $1 ORDER BY revision_number',
		[skillId],
	);
	return r.rows;
}

beforeAll(async () => {
	tempDataDir = join(
		tmpdir(),
		`hezo-test-default-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db, generateUnlockKey());
	await seedBuiltins(db, await loadAgentRoles());
	app = buildApp(db, masterKeyManager, { dataDir: tempDataDir, webUrl: '' }, createStubDocker());
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Default Skills Admin', true) RETURNING id",
	);
	token = await signAdminJwt(masterKeyManager, userResult.rows[0].id);

	const teamRes = await createTestTeam(db, { name: 'Default Skills Co' });
	const teamId = (await teamRes.json()).data.id;
	const proj = await createTestProject(db, teamId, { name: 'Scope Target', task_prefix: 'ST' });
	projectId = (await proj.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await db.query('DELETE FROM skills');
	await db.query('DELETE FROM system_meta WHERE key LIKE $1', [`${DEFAULT_SKILL_MARKER_PREFIX}%`]);
});

describe('seedDefaultSkills state machine', () => {
	it('inserts fresh skills as ordinary global rows and records markers, no revisions', async () => {
		const a = def('alpha', '# Alpha\n\nBody A.', { sourceUrl: 'https://github.com/x/y' });
		const b = def('beta', '# Beta\n\nBody B.');
		await seedDefaultSkills(db, [a, b]);

		const rowA = await getSkill('alpha');
		expect(rowA).toBeDefined();
		expect(rowA.name).toBe('Skill alpha');
		expect(rowA.description).toBe('Description for alpha');
		expect(rowA.content).toBe('# Alpha\n\nBody A.');
		expect(rowA.content_hash).toBe(a.contentHash);
		expect(rowA.source_url).toBe('https://github.com/x/y');
		expect(rowA.project_id).toBeNull();
		expect(rowA.created_by_member_id).toBeNull();
		expect(rowA.tags).toEqual([]);
		expect(rowA.is_active).toBe(true);

		expect(await getSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + 'alpha')).toBe(a.contentHash);
		expect(await getSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + 'beta')).toBe(b.contentHash);
		expect(await getRevisions(rowA.id)).toEqual([]);
	});

	it('is idempotent across repeated boots with unchanged content', async () => {
		const a = def('alpha', '# Alpha\n\nBody.');
		await seedDefaultSkills(db, [a]);
		const first = await getSkill('alpha');
		await seedDefaultSkills(db, [a]);
		const second = await getSkill('alpha');
		expect(second.updated_at).toEqual(first.updated_at);
		expect(second.content).toBe(first.content);
		expect(await getRevisions(second.id)).toEqual([]);
	});

	it('never clobbers a user-authored skill occupying the slug, even across content bumps', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, description, content, content_hash, tags, project_id)
			 VALUES ('My Own', 'alpha', 'mine', 'user content', 'userhash', '[]'::jsonb, NULL)`,
		);
		await seedDefaultSkills(db, [def('alpha', '# Shipped v1')]);
		expect((await getSkill('alpha')).content).toBe('user content');
		expect(await getSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + 'alpha')).toBe(FOREIGN_MARKER);

		// A later release with different content still keeps hands off — and even
		// deleting the user's skill must not summon the default afterwards.
		await seedDefaultSkills(db, [def('alpha', '# Shipped v2')]);
		expect((await getSkill('alpha')).content).toBe('user content');
		await db.query('DELETE FROM skills WHERE slug = $1', ['alpha']);
		await seedDefaultSkills(db, [def('alpha', '# Shipped v3')]);
		expect(await getSkill('alpha')).toBeUndefined();
	});

	it('never resurrects a deleted default skill', async () => {
		const v1 = def('alpha', '# v1');
		await seedDefaultSkills(db, [v1]);
		await db.query('DELETE FROM skills WHERE slug = $1', ['alpha']);

		await seedDefaultSkills(db, [v1]);
		expect(await getSkill('alpha')).toBeUndefined();
		await seedDefaultSkills(db, [def('alpha', '# v2 with new content')]);
		expect(await getSkill('alpha')).toBeUndefined();
		// Marker survives so the decision is durable.
		expect(await getSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + 'alpha')).toBe(v1.contentHash);
	});

	it('does not re-add a default skill the operator re-scoped to a project', async () => {
		await seedDefaultSkills(db, [def('alpha', '# v1')]);
		const row = await getSkill('alpha');
		await db.query('UPDATE skills SET project_id = $2 WHERE id = $1', [row.id, projectId]);

		await seedDefaultSkills(db, [def('alpha', '# v2')]);
		expect(await getSkill('alpha')).toBeUndefined(); // no new global row
		const scoped = await db.query<{ content: string }>(
			'SELECT content FROM skills WHERE id = $1 AND project_id = $2',
			[row.id, projectId],
		);
		expect(scoped.rows[0].content).toBe('# v1'); // project copy untouched
	});

	it('applies a shipped update to a pristine skill and records a revision', async () => {
		const v1 = def('alpha', '# v1 content');
		await seedDefaultSkills(db, [v1]);
		// Operator-owned fields set after seeding must survive the upgrade.
		await db.query(`UPDATE skills SET tags = '["ops"]'::jsonb WHERE slug = 'alpha'`);

		const v2 = def('alpha', '# v2 content', {
			name: 'Alpha Renamed',
			description: 'New description',
			sourceUrl: 'https://github.com/x/y/v2',
		});
		await seedDefaultSkills(db, [v2]);

		const row = await getSkill('alpha');
		expect(row.content).toBe('# v2 content');
		expect(row.content_hash).toBe(v2.contentHash);
		expect(row.name).toBe('Alpha Renamed');
		expect(row.description).toBe('New description');
		expect(row.source_url).toBe('https://github.com/x/y/v2');
		expect(row.tags).toEqual(['ops']);

		const revisions = await getRevisions(row.id);
		expect(revisions).toHaveLength(1);
		expect(revisions[0].content).toBe('# v1 content');
		expect(revisions[0].change_summary).toBe('Updated by Hezo upgrade');
		expect(revisions[0].author_member_id).toBeNull();
		expect(await getSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + 'alpha')).toBe(v2.contentHash);
	});

	it('leaves a user-edited skill untouched forever', async () => {
		const v1 = def('alpha', '# v1');
		await seedDefaultSkills(db, [v1]);
		// Simulate a content edit the way the PATCH route writes it.
		const edited = '# my edited version';
		const editedHash = createHash('sha256').update(edited).digest('hex');
		await db.query(
			`UPDATE skills SET content = $1, content_hash = $2, updated_at = now() WHERE slug = 'alpha'`,
			[edited, editedHash],
		);

		await seedDefaultSkills(db, [def('alpha', '# v2')]);
		const row = await getSkill('alpha');
		expect(row.content).toBe(edited);
		expect(await getRevisions(row.id)).toEqual([]);
		// Marker stays at the last applied ship, so the edit remains detected.
		expect(await getSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + 'alpha')).toBe(v1.contentHash);

		await seedDefaultSkills(db, [def('alpha', '# v3')]);
		expect((await getSkill('alpha')).content).toBe(edited);
	});

	it('isolates a failing skill so the rest still seed', async () => {
		const broken = def('broken', '# body');
		// NOT NULL violation on insert — seedOne throws, seedDefaultSkills logs
		// and continues (this test deliberately exercises that error path).
		(broken as { name: string | null }).name = null;
		const good = def('good', '# good body');

		await seedDefaultSkills(db, [broken, good]);
		expect(await getSkill('good')).toBeDefined();
		expect(await getSkill('broken')).toBeUndefined();
		// The failed transaction must not have recorded a marker.
		expect(await getSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + 'broken')).toBeNull();
	});
});

describe('seeded default skills through the REST surface', () => {
	it('lists the real shipped skills as editable rows and allows PATCH/DELETE', async () => {
		await seedDefaultSkills(db, await loadDefaultSkills());

		const listRes = await app.request('/api/skills', { headers: authHeader(token) });
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()).data as Array<{
			id: string;
			slug: string;
			readonly?: boolean;
		}>;
		const codeReview = list.find((s) => s.slug === 'code-review');
		expect(codeReview).toBeDefined();
		expect(codeReview?.readonly).toBe(false);

		const patchRes = await app.request(`/api/skills/${codeReview?.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# my customized review process' }),
		});
		expect(patchRes.status).toBe(200);

		const deleteTarget = list.find((s) => s.slug === 'brainstorming');
		const deleteRes = await app.request(`/api/skills/${deleteTarget?.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(deleteRes.status).toBe(200);
	});
});
