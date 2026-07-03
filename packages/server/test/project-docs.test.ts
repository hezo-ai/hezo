import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { loadAgentRoles } from '../src/db/agent-roles';
import { seedBuiltins } from '../src/db/seed';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let tempDataDir: string;

beforeAll(async () => {
	tempDataDir = join(tmpdir(), `hezo-test-docs-${Date.now()}`);
	mkdirSync(tempDataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateUnlockKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	await seedBuiltins(db, await loadAgentRoles());
	app = buildApp(db, masterKeyManager, { dataDir: tempDataDir, webUrl: '' }, createStubDocker());
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Test Admin', true) RETURNING id",
	);
	token = await signAdminJwt(masterKeyManager, userResult.rows[0].id);

	const teamRes = await createTestTeam(db, { name: 'Doc Test Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main Project',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

describe('Project docs (DB-backed)', () => {
	it('lists the default doc seeded at creation', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.map((d: any) => d.filename)).toEqual(['architecture-guidelines.md']);
	});

	it('creates a doc via PUT', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/spec.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# Tech Spec\n\nThis is the spec.' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.filename).toBe('spec.md');
		expect(body.data.content).toContain('Tech Spec');
		expect(body.data.id).toBeDefined();
	});

	it('rejects non-markdown filenames (docs are markdown-only)', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/page.html`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '<h1>nope</h1>' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('reads the doc back with created_at + last editor for the metadata banner', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/spec.md`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('Tech Spec');
		expect(typeof body.data.created_at).toBe('string');
		expect(typeof body.data.updated_at).toBe('string');
		// A human write resolves to the editor's name + the non-agent 'admin' badge.
		expect(body.data.last_updated_by_type).toBe('admin');
		expect(body.data.last_updated_by_name).toBe('Test Admin');
	});

	it('lists docs after creating one', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.some((d: any) => d.filename === 'spec.md')).toBe(true);
	});

	it('returns 404 for non-existent doc', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/non-existent.md`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('updates a doc via PUT (upsert)', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/spec.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# Tech Spec v2\n\nUpdated spec.' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('v2');
	});

	it('deletes a doc', async () => {
		await app.request(`/api/projects/${projectId}/docs/to-delete.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'temp' }),
		});

		const deleteRes = await app.request(`/api/projects/${projectId}/docs/to-delete.md`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(deleteRes.status).toBe(200);

		const getRes = await app.request(`/api/projects/${projectId}/docs/to-delete.md`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);
	});

	it('works for projects without a designated repo', async () => {
		// Project docs are DB-backed, so no repo is needed
		const res = await app.request(`/api/projects/${projectId}/docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});

	it('stores docs in the database', async () => {
		const result = await db.query(
			"SELECT * FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[projectId, 'spec.md'],
		);
		expect(result.rows.length).toBe(1);
		expect((result.rows[0] as any).content).toContain('Tech Spec v2');
	});

	it('creates multiple docs for same project', async () => {
		await app.request(`/api/projects/${projectId}/docs/prd.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# PRD\n\nProduct requirements.' }),
		});
		await app.request(`/api/projects/${projectId}/docs/implementation-plan.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# Implementation Plan\n\nPhase 1...' }),
		});

		const res = await app.request(`/api/projects/${projectId}/docs`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		const filenames = body.data.map((d: any) => d.filename);
		expect(filenames).toContain('prd.md');
		expect(filenames).toContain('implementation-plan.md');
		expect(filenames).toContain('spec.md');
	});
});

describe('Project doc revisions and restore', () => {
	const filename = 'revisioned.md';

	it('updates create revisions of prior content', async () => {
		await app.request(`/api/projects/${projectId}/docs/${filename}`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'v1' }),
		});
		await app.request(`/api/projects/${projectId}/docs/${filename}`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'v2', change_summary: 'second pass' }),
		});

		const revRes = await app.request(`/api/projects/${projectId}/docs/${filename}/revisions`, {
			headers: authHeader(token),
		});
		expect(revRes.status).toBe(200);
		const revBody = await revRes.json();
		expect(revBody.data.length).toBe(1);
		expect(revBody.data[0].content).toBe('v1');
		expect(revBody.data[0].change_summary).toBe('second pass');
	});

	it('restores to a previous revision and snapshots the pre-restore content', async () => {
		await app.request(`/api/projects/${projectId}/docs/${filename}`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'v3', change_summary: 'third' }),
		});

		const restoreRes = await app.request(`/api/projects/${projectId}/docs/${filename}/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(restoreRes.status).toBe(200);
		const restored = await restoreRes.json();
		expect(restored.data.content).toBe('v1');

		const revRes = await app.request(`/api/projects/${projectId}/docs/${filename}/revisions`, {
			headers: authHeader(token),
		});
		const revBody = await revRes.json();
		expect(revBody.data.length).toBe(3);
		expect(revBody.data[0].change_summary).toBe('Restored content from revision 1');
		expect(revBody.data[0].content).toBe('v3');
	});

	it('returns 404 when restoring an unknown revision', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/${filename}/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 999 }),
		});
		expect(res.status).toBe(404);
	});

	it('returns 404 when restoring on a doc that does not exist', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/missing.md/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(res.status).toBe(404);
	});
});

describe('AGENTS.md (filesystem-based)', () => {
	let repoProjectId: string;

	const makeTeam = async (name: string) => {
		const r = await createTestTeam(db, { name });
		return (await r.json()).data.id as string;
	};

	beforeAll(async () => {
		// A project with a designated repo. Under the 1:1 teams↔projects model the
		// repo-bearing project gets its own team so it doesn't mutate the shared
		// primary project used by the DB-backed doc tests above.
		const repoTeamId = await makeTeam('Repo Test Co');
		const projRes = await createTestProject(db, repoTeamId, {
			name: 'Repo Project',
			description: 'Test project.',
		});
		repoProjectId = (await projRes.json()).data.id;

		const repoResult = await db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'org/main-app', 'github') RETURNING id`,
			[repoProjectId],
		);
		const repoId = (repoResult.rows[0] as any).id;
		await db.query('UPDATE projects SET designated_repo_id = $1, slug = $2 WHERE id = $3', [
			repoId,
			'repo-project',
			repoProjectId,
		]);

		// Get the repo project's team slug for the on-disk repo path.
		const team = await db.query<{ slug: string }>('SELECT slug FROM teams WHERE id = $1', [
			repoTeamId,
		]);
		const teamSlug = team.rows[0].slug;
		const repoDir = join(tempDataDir, 'teams', teamSlug, 'projects', 'repo-project', 'main-app');
		mkdirSync(repoDir, { recursive: true });
	});

	it('writes and reads AGENTS.md', async () => {
		const writeRes = await app.request(`/api/projects/${repoProjectId}/agents-md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# Agent Rules\n\nFollow these rules.' }),
		});
		expect(writeRes.status).toBe(200);

		const readRes = await app.request(`/api/projects/${repoProjectId}/agents-md`, {
			headers: authHeader(token),
		});
		expect(readRes.status).toBe(200);
		const body = await readRes.json();
		expect(body.data.content).toContain('Agent Rules');
	});

	it('returns 404 for AGENTS.md on project without repo', async () => {
		// A fresh team yields a brand-new project with no designated repo. Reusing an
		// existing team would return one of the projects already configured above
		// (the primary or the repo-bearing one) under the 1:1 invariant.
		const noRepoTeamId = await makeTeam('No Repo Co');
		const projRes = await createTestProject(db, noRepoTeamId, {
			name: 'No Repo',
			description: 'Test project.',
		});
		const noRepoProjId = (await projRes.json()).data.id;

		const res = await app.request(`/api/projects/${noRepoProjId}/agents-md`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});
