import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { auditLog } from '../src/lib/audit';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Audit Co' });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;

	const project = await createTestProject(db, teamId, { name: 'Audit Project' });
	const projectData = (await project.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('audit log', () => {
	it('inserts a project-scoped audit entry via helper', async () => {
		await auditLog(db, {
			projectId,
			actorType: 'admin',
			actorMemberId: null,
			action: 'created',
			entityType: 'task',
			entityId: null,
			details: { title: 'Test' },
		});

		const res = await app.request(`/api/projects/${projectSlug}/audit-log`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		const entry = body.data.find(
			(e: Record<string, unknown>) => e.action === 'created' && e.entity_type === 'task',
		);
		expect(entry).toBeDefined();
		expect(entry.project_id).toBe(projectId);
		expect(entry.details).toEqual({ title: 'Test' });
	});

	it('filters by entity_type', async () => {
		await auditLog(db, {
			projectId,
			actorType: 'system',
			actorMemberId: null,
			action: 'updated',
			entityType: 'agent',
			entityId: null,
		});

		const res = await app.request(`/api/projects/${projectSlug}/audit-log?entity_type=agent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((e: Record<string, unknown>) => e.entity_type === 'agent')).toBe(true);
	});

	it('filters by action', async () => {
		await auditLog(db, {
			projectId,
			actorType: 'admin',
			actorMemberId: null,
			action: 'deleted',
			entityType: 'project',
			entityId: null,
		});

		const res = await app.request(`/api/projects/${projectSlug}/audit-log?action=deleted`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((e: Record<string, unknown>) => e.action === 'deleted')).toBe(true);
	});

	it('filters by date range', async () => {
		const future = new Date(Date.now() + 86400000).toISOString();
		const res = await app.request(`/api/projects/${projectSlug}/audit-log?from=${future}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('supports pagination', async () => {
		for (let i = 0; i < 5; i++) {
			await auditLog(db, {
				projectId,
				actorType: 'system',
				actorMemberId: null,
				action: 'created',
				entityType: 'task',
				entityId: null,
				details: { i },
			});
		}

		const res = await app.request(`/api/projects/${projectSlug}/audit-log?page=1&per_page=2`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeLessThanOrEqual(2);
		expect(body.meta).toBeDefined();
		expect(body.meta.page).toBe(1);
		expect(body.meta.per_page).toBe(2);
		expect(body.meta.total).toBeGreaterThanOrEqual(5);
	});

	it('scopes the per-project view to its project only', async () => {
		// An instance-level row (no project) must not leak into the project view.
		await auditLog(db, {
			actorType: 'admin',
			actorMemberId: null,
			action: 'created',
			entityType: 'secret',
			entityId: null,
			details: { name: 'INSTANCE_ONLY' },
		});

		const res = await app.request(`/api/projects/${projectSlug}/audit-log`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((e: Record<string, unknown>) => e.project_id === projectId)).toBe(true);
		expect(body.data.some((e: Record<string, unknown>) => e.entity_type === 'secret')).toBe(false);
	});

	it('exposes the instance view to superusers with project + instance rows', async () => {
		await auditLog(db, {
			actorType: 'admin',
			actorMemberId: null,
			action: 'created',
			entityType: 'secret',
			entityId: null,
			details: { name: 'INSTANCE_KEY' },
		});

		const res = await app.request('/api/audit-log', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		// Includes the instance-scoped (project_id NULL) row plus project-scoped rows.
		expect(body.data.some((e: Record<string, unknown>) => e.project_id === null)).toBe(true);
		const projectRow = body.data.find((e: Record<string, unknown>) => e.project_id === projectId);
		expect(projectRow).toBeDefined();
		expect(projectRow.project_slug).toBe(projectSlug);
		// The team dimension is gone.
		expect('team_id' in body.data[0]).toBe(false);
	});

	it('denies the instance view to non-superusers', async () => {
		const userRes = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Regular User', false) RETURNING id",
		);
		const nonSuperToken = await signAdminJwt(masterKeyManager, userRes.rows[0].id);

		const res = await app.request('/api/audit-log', { headers: authHeader(nonSuperToken) });
		expect(res.status).toBe(403);
	});
});
