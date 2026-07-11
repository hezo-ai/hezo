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
import { parseGitHubRawUrl, SkillDownloadError } from '../src/services/skill-downloader';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectAId: string;
let projectBId: string;
let tempDataDir: string;

beforeAll(async () => {
	tempDataDir = join(
		tmpdir(),
		`hezo-test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db, generateUnlockKey());
	await seedBuiltins(db, await loadAgentRoles());
	app = buildApp(db, masterKeyManager, { dataDir: tempDataDir, webUrl: '' }, createStubDocker());
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Skills Admin', true) RETURNING id",
	);
	token = await signAdminJwt(masterKeyManager, userResult.rows[0].id);

	const teamRes = await createTestTeam(db, { name: 'Skills Co' });
	teamId = (await teamRes.json()).data.id;
	const projA = await createTestProject(db, teamId, { name: 'Project A', task_prefix: 'PA' });
	projectAId = (await projA.json()).data.id;

	const teamBRes = await createTestTeam(db, { name: 'Skills Co B' });
	const teamBId = (await teamBRes.json()).data.id;
	const projB = await createTestProject(db, teamBId, { name: 'Project B', task_prefix: 'PB' });
	projectBId = (await projB.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await db.query('DELETE FROM skills');
});

describe('parseGitHubRawUrl', () => {
	it('converts GitHub blob URL to raw URL', () => {
		expect(parseGitHubRawUrl('https://github.com/owner/repo/blob/main/path/to/skill.md')).toBe(
			'https://raw.githubusercontent.com/owner/repo/main/path/to/skill.md',
		);
	});

	it('passes raw GitHub URLs through unchanged', () => {
		const raw = 'https://raw.githubusercontent.com/owner/repo/main/skill.md';
		expect(parseGitHubRawUrl(raw)).toBe(raw);
	});

	it('rejects invalid URLs', () => {
		expect(() => parseGitHubRawUrl('not a url')).toThrow(SkillDownloadError);
	});
});

describe('global skills CRUD (/api/skills)', () => {
	async function create(body: Record<string, unknown>): Promise<Response> {
		return app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	it('creates, lists, reads, updates, and deletes a global skill (by id)', async () => {
		const created = await create({
			name: 'Code Review',
			content: '# Code Review\nReview the diff carefully.',
			tags: ['quality'],
		});
		expect(created.status).toBe(201);
		const skill = (await created.json()).data as { id: string; slug: string; project_id: null };
		expect(skill.slug).toBe('code-review');
		expect(skill.project_id).toBeNull();

		const list = await app.request('/api/skills', { headers: authHeader(token) });
		expect((await list.json()).data.some((s: { slug: string }) => s.slug === 'code-review')).toBe(
			true,
		);

		const read = await app.request(`/api/skills/${skill.id}`, { headers: authHeader(token) });
		expect((await read.json()).data.content).toContain('Review the diff');

		const patched = await app.request(`/api/skills/${skill.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# Code Review\nUpdated body.' }),
		});
		expect(patched.status).toBe(200);

		const del = await app.request(`/api/skills/${skill.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);
		const gone = await app.request(`/api/skills/${skill.id}`, { headers: authHeader(token) });
		expect(gone.status).toBe(404);
	});

	it('re-POST with the same slug upserts within the same (global) scope', async () => {
		await create({ name: 'Dup', slug: 'dup', content: 'v1' });
		const second = await create({ name: 'Dup', slug: 'dup', content: 'v2' });
		expect(second.status).toBe(201);
		const id = (await second.json()).data.id as string;
		const read = await app.request(`/api/skills/${id}`, { headers: authHeader(token) });
		expect((await read.json()).data.content).toBe('v2');
	});
});

describe('skill scope (create + re-scope on /api/skills)', () => {
	async function create(body: Record<string, unknown>): Promise<Response> {
		return app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	it('creates a project-scoped skill and the admin list annotates its project', async () => {
		const created = await create({
			name: 'Scoped',
			slug: 'scoped',
			content: 'body',
			project_id: projectAId,
		});
		expect(created.status).toBe(201);
		expect((await created.json()).data.project_id).toBe(projectAId);

		const list = await app.request('/api/skills', { headers: authHeader(token) });
		const row = (await list.json()).data.find((s: { slug: string }) => s.slug === 'scoped');
		expect(row.project_id).toBe(projectAId);
		expect(row.project_name).toBe('Project A');
	});

	it('re-scopes a global skill to a project and back via PATCH', async () => {
		const created = await create({ name: 'Movable', slug: 'movable', content: 'body' });
		const id = (await created.json()).data.id as string;

		const toProject = await app.request(`/api/skills/${id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectAId }),
		});
		expect(toProject.status).toBe(200);
		expect((await toProject.json()).data.project_id).toBe(projectAId);

		const toGlobal = await app.request(`/api/skills/${id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: '' }),
		});
		expect(toGlobal.status).toBe(200);
		expect((await toGlobal.json()).data.project_id).toBeNull();
	});

	it('409s when re-scoping into a scope that already holds the slug', async () => {
		// A global 'clash' and a project-A 'clash' coexist (partitioned uniqueness).
		const g = await create({ name: 'Clash', slug: 'clash', content: 'g' });
		const gId = (await g.json()).data.id as string;
		await create({ name: 'Clash', slug: 'clash', content: 'p', project_id: projectAId });

		// Moving the global one into project A collides with the project-A 'clash'.
		const conflict = await app.request(`/api/skills/${gId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectAId }),
		});
		expect(conflict.status).toBe(409);
	});
});

describe('per-project skills routes (/api/projects/:projectId/skills)', () => {
	async function createScoped(
		body: Record<string, unknown>,
	): Promise<{ id: string; slug: string }> {
		const res = await app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return (await res.json()).data;
	}

	it('lists this project’s own skills plus globals', async () => {
		await createScoped({ name: 'Glob', slug: 'glob', content: 'g' });
		const own = await createScoped({
			name: 'Own',
			slug: 'own',
			content: 'o',
			project_id: projectAId,
		});
		await createScoped({ name: 'Other', slug: 'other', content: 'x', project_id: projectBId });

		const res = await app.request(`/api/projects/${projectAId}/skills`, {
			headers: authHeader(token),
		});
		const slugs = (await res.json()).data.map((s: { slug: string }) => s.slug);
		expect(slugs).toContain('glob'); // global visible
		expect(slugs).toContain('own'); // own project visible
		expect(slugs).not.toContain('other'); // another project's skill hidden
		expect(own.id).toBeTruthy();
	});

	it('edits and removes the project’s own skill but not a global or another project’s', async () => {
		const own = await createScoped({
			name: 'Edit Me',
			slug: 'edit-me',
			content: 'v1',
			project_id: projectAId,
		});
		const global = await createScoped({ name: 'Keep', slug: 'keep', content: 'g' });

		const edit = await app.request(`/api/projects/${projectAId}/skills/${own.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'v2' }),
		});
		expect(edit.status).toBe(200);
		expect((await edit.json()).data.content).toBe('v2');

		// A global skill is not this project's to edit → 404 (guarded by project_id).
		const editGlobal = await app.request(`/api/projects/${projectAId}/skills/${global.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'nope' }),
		});
		expect(editGlobal.status).toBe(404);

		const delGlobal = await app.request(`/api/projects/${projectAId}/skills/${global.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(delGlobal.status).toBe(404);

		const delOwn = await app.request(`/api/projects/${projectAId}/skills/${own.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(delOwn.status).toBe(200);
	});
});

describe('skill revisions (/api/skills/:id/revisions, /restore)', () => {
	async function create(body: Record<string, unknown>): Promise<string> {
		const res = await app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return (await res.json()).data.id as string;
	}
	async function patch(id: string, content: string): Promise<Response> {
		return app.request(`/api/skills/${id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content }),
		});
	}
	async function revisions(
		id: string,
	): Promise<{ revision_number: number; content: string; change_summary: string }[]> {
		const res = await app.request(`/api/skills/${id}/revisions`, { headers: authHeader(token) });
		return (await res.json()).data;
	}

	it('records a revision of the prior content on each content change (none on create)', async () => {
		const id = await create({ name: 'Rev', slug: 'rev', content: 'v1' });
		// First create snapshots nothing — the history is empty until an edit.
		expect(await revisions(id)).toHaveLength(0);

		await patch(id, 'v2');
		await patch(id, 'v3');

		const history = await revisions(id);
		expect(history.map((r) => r.content)).toEqual(['v2', 'v1']); // newest-first, prior content
		expect(history.map((r) => r.revision_number)).toEqual([2, 1]);
	});

	it('does not record a revision when content is unchanged', async () => {
		const id = await create({ name: 'Same', slug: 'same', content: 'body' });
		await patch(id, 'body');
		expect(await revisions(id)).toHaveLength(0);
	});

	it('restores a prior revision and snapshots the replaced content', async () => {
		const id = await create({ name: 'Restore', slug: 'restore', content: 'v1' });
		await patch(id, 'v2');
		await patch(id, 'v3'); // revisions: rev2=v2, rev1=v1

		const restored = await app.request(`/api/skills/${id}/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(restored.status).toBe(200);
		expect((await restored.json()).data.content).toBe('v1');

		const read = await app.request(`/api/skills/${id}`, { headers: authHeader(token) });
		expect((await read.json()).data.content).toBe('v1');

		const history = await revisions(id);
		// The replaced 'v3' is snapshotted as the newest revision.
		expect(history[0].content).toBe('v3');
		expect(history[0].change_summary).toBe('Restored to revision 1');
	});

	it('400s without a revision_number and 404s for a missing revision', async () => {
		const id = await create({ name: 'Bad', slug: 'bad', content: 'v1' });
		const noBody = await app.request(`/api/skills/${id}/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(noBody.status).toBe(400);

		const missing = await app.request(`/api/skills/${id}/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 99 }),
		});
		expect(missing.status).toBe(404);
	});
});

describe('template resolver {{skills_context}} (global)', () => {
	it('injects the skill manifest (name + slug) from the global skills table', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, content, content_hash, is_active)
			 VALUES ('Direct Skill', 'direct-skill', '# Direct Skill\nDo the thing.', 'hash', true)`,
		);

		const resolved = await resolveSystemPrompt(db, 'Agent prompt.\n\n{{skills_context}}\n\nEnd.', {
			teamId,
			dataDir: tempDataDir,
		});

		// Manifest lists name + slug, not the full body.
		expect(resolved).toContain('- Direct Skill (slug: direct-skill)');
		expect(resolved).not.toContain('Do the thing.');
	});

	it('still lists the built-in connector-recipes skill when there are no DB skills', async () => {
		await db.query('DELETE FROM skills');
		const resolved = await resolveSystemPrompt(db, '{{skills_context}}', {
			teamId,
			dataDir: tempDataDir,
		});
		// The empty-DB case no longer emits a placeholder — the built-in virtual
		// skill always appears in the manifest.
		expect(resolved).toContain('The team skills database holds reusable know-how.');
		expect(resolved).toContain('(slug: connector-recipes)');
	});

	it('lists every active skill in the manifest', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, content, content_hash, is_active)
			 VALUES ('Deploy', 'deploy', '# Deploy', 'h', true),
			        ('React', 'react', '# React', 'h', true)`,
		);
		const resolved = await resolveSystemPrompt(db, '{{skills_context}}', {
			teamId,
			dataDir: tempDataDir,
		});
		expect(resolved).toContain('- Deploy (slug: deploy)');
		expect(resolved).toContain('- React (slug: react)');
	});

	it('scopes the manifest to the run’s project (its own skills + globals)', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, content, content_hash, is_active, project_id)
			 VALUES ('Global One', 'global-one', '# g', 'h', true, NULL),
			        ('A Only', 'a-only', '# a', 'h', true, $1),
			        ('B Only', 'b-only', '# b', 'h', true, $2)`,
			[projectAId, projectBId],
		);
		const resolved = await resolveSystemPrompt(db, '{{skills_context}}', {
			teamId,
			projectId: projectAId,
			dataDir: tempDataDir,
		});
		expect(resolved).toContain('- Global One (slug: global-one)');
		expect(resolved).toContain('- A Only (slug: a-only)');
		expect(resolved).not.toContain('b-only'); // another project's skill is not injected
	});

	it('a project skill shadows a global skill of the same slug', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, content, content_hash, is_active, project_id)
			 VALUES ('Deploy Global', 'deploy', '# g', 'h', true, NULL),
			        ('Deploy Project', 'deploy', '# p', 'h', true, $1)`,
			[projectAId],
		);
		const resolved = await resolveSystemPrompt(db, '{{skills_context}}', {
			teamId,
			projectId: projectAId,
			dataDir: tempDataDir,
		});
		// Only one 'deploy' line, and it's the project's shadowing copy.
		expect(resolved).toContain('- Deploy Project (slug: deploy)');
		expect(resolved).not.toContain('Deploy Global');
	});
});
