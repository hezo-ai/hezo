import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { loadAgentRoles } from '../src/db/agent-roles';
import type { Db } from '../src/db/database';
import { seedBuiltins } from '../src/db/seed';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

function iconForm(bytes: Buffer, type = 'image/png'): FormData {
	const fd = new FormData();
	fd.set('file', new Blob([bytes], { type }), 'icon.png');
	return fd;
}

function pngWithDimensions(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write('IHDR', 4, 'ascii');
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([sig, ihdr]);
}

describe('projects routes — read + intake + icon-validation branches', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let teamId: string;
	let projectId: string;
	let projectSlug: string;

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;

		const teamRes = await createTestTeam(db, { name: 'Projects Cov Co' });
		teamId = (await teamRes.json()).data.id;
		const projRes = await createTestProject(db, teamId, {
			name: 'Cov Project',
			description: 'A project for exercising route branch coverage.',
		});
		const proj = (await projRes.json()).data;
		projectId = proj.id;
		projectSlug = proj.slug;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	describe('GET /project-intakes — home intake getter', () => {
		it('returns null when no intake conversation is open', async () => {
			const res = await app.request('/api/project-intakes', { headers: authHeader(token) });
			expect(res.status).toBe(200);
			// No intake has been opened in this suite, so the home getter yields null.
			expect((await res.json()).data).toBeNull();
		});
	});

	describe('GET /projects/:projectId/progress', () => {
		it('returns the Captain-maintained progress summary', async () => {
			await db.query(
				`UPDATE projects SET progress_summary = $2, progress_summary_updated_at = now()
				 WHERE id = $1`,
				[projectId, 'Phase 1 underway.'],
			);
			const res = await app.request(`/api/projects/${projectSlug}/progress`, {
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).data.summary).toBe('Phase 1 underway.');
		});
	});

	describe('PATCH /projects/:projectId — single budget window merge', () => {
		it('validates the merged trio when only one budget window is supplied', async () => {
			// First set a consistent baseline trio.
			await app.request(`/api/projects/${projectSlug}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					daily_budget_cents: 1000,
					weekly_budget_cents: 8000,
					monthly_budget_cents: 40000,
				}),
			});
			// Now PATCH only the daily window — the merge picks up the stored weekly/monthly.
			const res = await app.request(`/api/projects/${projectSlug}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ daily_budget_cents: 1100 }),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).data.daily_budget_cents).toBe(1100);
		});

		it('rejects a single-window PATCH that makes the merged trio inconsistent', async () => {
			// Stored weekly is 8000; a daily of 9000 (×7 = 63000 > 8000) is inconsistent.
			const res = await app.request(`/api/projects/${projectSlug}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ daily_budget_cents: 9000 }),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error.code).toBe('INVALID_REQUEST');
		});
	});

	describe('DELETE /projects/:projectId/icon — idempotent clear', () => {
		it('200s and reports a null icon even when none is set', async () => {
			const res = await app.request(`/api/projects/${projectSlug}/icon`, {
				method: 'DELETE',
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).data.icon_url).toBeNull();
		});
	});

	describe('GET /projects/:projectId — resolved-but-not-found', () => {
		it('200s and includes repos for a normal project', async () => {
			const res = await app.request(`/api/projects/${projectSlug}`, { headers: authHeader(token) });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data.id).toBe(projectId);
			expect(Array.isArray(body.data.repos)).toBe(true);
		});
	});

	describe('PUT /projects/:projectId/icon — upload validation', () => {
		it('400s when the multipart body has no file field', async () => {
			const fd = new FormData();
			fd.set('notfile', 'x');
			const res = await app.request(`/api/projects/${projectSlug}/icon`, {
				method: 'PUT',
				headers: authHeader(token),
				body: fd,
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error.message).toMatch(/Missing file field/);
		});

		it('400s when the image header cannot be parsed for dimensions', async () => {
			// A valid PNG content-type but bytes that are not a parseable PNG header.
			const res = await app.request(`/api/projects/${projectSlug}/icon`, {
				method: 'PUT',
				headers: authHeader(token),
				body: iconForm(Buffer.from('not a real png'), 'image/png'),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error.message).toMatch(/Could not read image dimensions/);
		});

		it('uploads a valid icon (happy path through the route)', async () => {
			const res = await app.request(`/api/projects/${projectSlug}/icon`, {
				method: 'PUT',
				headers: authHeader(token),
				body: iconForm(pngWithDimensions(256, 256)),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).data.icon_url).toBeTruthy();
		});
	});

	describe('DELETE /projects/:projectId — not found / internal guard', () => {
		it('404s when a project the team cannot resolve is targeted', async () => {
			const res = await app.request('/api/projects/totally-unknown-slug', {
				method: 'DELETE',
				headers: authHeader(token),
			});
			expect(res.status).toBe(404);
		});

		it('deletes a project with no open tasks', async () => {
			// Stand up a disposable project, close its planning task, then delete it.
			const teamRes = await createTestTeam(db, { name: 'Disposable Co' });
			const dispTeamId = (await teamRes.json()).data.id;
			const projRes = await createTestProject(db, dispTeamId, {
				name: 'Disposable',
				description: 'A project that will be deleted in a test.',
			});
			const disp = (await projRes.json()).data;
			await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE project_id = $1`, [
				disp.id,
			]);
			const res = await app.request(`/api/projects/${disp.slug}`, {
				method: 'DELETE',
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			const gone = await db.query('SELECT 1 FROM projects WHERE id = $1', [disp.id]);
			expect(gone.rows.length).toBe(0);
		});
	});
});

describe('public project icon serve endpoint — signature branches', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let projectSlug: string;
	let projectId: string;

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Public Icon Project',
				description: 'A project whose icon is served via signed URL.',
			}),
		});
		const proj = (await res.json()).data;
		projectSlug = proj.slug;
		projectId = proj.id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('401s when the signature query params are missing', async () => {
		const res = await app.request(`/api/projects/${projectId}/icon`);
		expect(res.status).toBe(401);
		expect((await res.json()).error.message).toMatch(/Missing signature/);
	});

	it('401s when the signature is present but invalid', async () => {
		const res = await app.request(`/api/projects/${projectId}/icon?exp=9999999999&sig=deadbeef`);
		expect(res.status).toBe(401);
		expect((await res.json()).error.message).toMatch(/Invalid or expired/);
	});

	it('404s with a valid signature when no icon row exists', async () => {
		// Upload then delete so the signed URL is valid but the row is gone.
		await app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(128, 128)),
		});
		const list = await app.request('/api/projects', { headers: authHeader(token) });
		const project = (await list.json()).data.find(
			(p: { slug: string; icon_url: string }) => p.slug === projectSlug,
		);
		const iconUrl: string = project.icon_url;
		// Drop the icon row directly, leaving the previously-signed URL valid.
		await db.query('DELETE FROM project_icons WHERE project_id = $1', [projectId]);

		const res = await app.request(iconUrl);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Icon not found/);
	});
});

describe('container/start — docker error path', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let projectSlug: string;
	let projectId: string;
	let tempDataDir: string;

	beforeAll(async () => {
		tempDataDir = join(tmpdir(), `hezo-test-proj-docker-${Date.now()}`);
		mkdirSync(tempDataDir, { recursive: true });
		db = await createTestDbWithMigrations();
		const masterKeyManager = new MasterKeyManager();
		await masterKeyManager.initialize(db, generateUnlockKey());
		await seedBuiltins(db, await loadAgentRoles());
		// A docker stub whose startContainer throws — drives the catch in container/start.
		const docker = createStubDocker({
			startContainer: async () => {
				throw new Error('simulated docker failure');
			},
		});
		app = buildApp(db, masterKeyManager, { dataDir: tempDataDir, webUrl: '' }, docker);
		const userResult = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Test Admin', true) RETURNING id",
		);
		token = await signAdminJwt(masterKeyManager, userResult.rows[0].id);

		const teamRes = await createTestTeam(db, { name: 'Docker Err Co' });
		const dteamId = (await teamRes.json()).data.id;
		const projRes = await createTestProject(db, dteamId, {
			name: 'Docker Err Project',
			description: 'Exercises the container/start docker error branch.',
		});
		const proj = (await projRes.json()).data;
		projectSlug = proj.slug;
		projectId = proj.id;
		await db.query(
			`UPDATE projects SET container_id = 'stub-container',
			        container_status = 'stopped'::container_status WHERE id = $1`,
			[projectId],
		);
	});

	afterAll(async () => {
		await safeClose(db);
		rmSync(tempDataDir, { recursive: true, force: true });
	});

	it('500s with DOCKER_ERROR when startContainer throws', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/container/start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error.code).toBe('DOCKER_ERROR');
		expect(body.error.message).toMatch(/simulated docker failure/);
	});
});
