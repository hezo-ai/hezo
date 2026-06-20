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
let teamSlug: string;
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
	teamSlug = teamData.slug;

	const project = await createTestProject(db, teamId, { name: 'Audit Project' });
	const projectData = (await project.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('audit log', () => {
	it('inserts an audit entry via helper', async () => {
		await auditLog(db, {
			teamId,
			actorType: 'admin',
			actorMemberId: null,
			action: 'created',
			entityType: 'task',
			entityId: null,
			details: { title: 'Test' },
		});

		const res = await app.request(`/api/projects/${projectSlug}/team-audit-log`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		const entry = body.data.find(
			(e: Record<string, unknown>) => e.action === 'created' && e.entity_type === 'task',
		);
		expect(entry).toBeDefined();
		expect(entry.details).toEqual({ title: 'Test' });
	});

	it('filters by entity_type', async () => {
		await auditLog(db, {
			teamId,
			actorType: 'system',
			actorMemberId: null,
			action: 'updated',
			entityType: 'agent',
			entityId: null,
		});

		const res = await app.request(`/api/projects/${projectSlug}/team-audit-log?entity_type=agent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((e: Record<string, unknown>) => e.entity_type === 'agent')).toBe(true);
	});

	it('filters by action', async () => {
		await auditLog(db, {
			teamId,
			actorType: 'admin',
			actorMemberId: null,
			action: 'deleted',
			entityType: 'project',
			entityId: null,
		});

		const res = await app.request(`/api/projects/${projectSlug}/team-audit-log?action=deleted`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((e: Record<string, unknown>) => e.action === 'deleted')).toBe(true);
	});

	it('filters by date range', async () => {
		const future = new Date(Date.now() + 86400000).toISOString();
		const res = await app.request(`/api/projects/${projectSlug}/team-audit-log?from=${future}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('supports pagination', async () => {
		for (let i = 0; i < 5; i++) {
			await auditLog(db, {
				teamId,
				actorType: 'system',
				actorMemberId: null,
				action: 'created',
				entityType: 'task',
				entityId: null,
				details: { i },
			});
		}

		const res = await app.request(`/api/projects/${projectSlug}/team-audit-log?page=1&per_page=2`, {
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

	it('scopes the per-project view to its project, and ?project_id filters the team view', async () => {
		await auditLog(db, {
			teamId,
			projectId,
			actorType: 'admin',
			actorMemberId: null,
			action: 'created',
			entityType: 'document',
			entityId: null,
			details: { slug: 'scoped.md' },
		});

		const projectRes = await app.request(`/api/projects/${projectSlug}/audit-log`, {
			headers: authHeader(token),
		});
		expect(projectRes.status).toBe(200);
		const projectBody = await projectRes.json();
		expect(projectBody.data.length).toBeGreaterThanOrEqual(1);
		expect(projectBody.data.every((e: Record<string, unknown>) => e.project_id === projectId)).toBe(
			true,
		);

		const filteredRes = await app.request(
			`/api/projects/${projectSlug}/team-audit-log?project_id=${projectId}`,
			{ headers: authHeader(token) },
		);
		const filteredBody = await filteredRes.json();
		expect(
			filteredBody.data.every((e: Record<string, unknown>) => e.project_id === projectId),
		).toBe(true);
	});

	it('exposes the instance view to superusers with cross-team rows', async () => {
		await auditLog(db, {
			teamId: null,
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
		// Includes the instance-scoped (team_id NULL) row plus team-scoped rows.
		expect(body.data.some((e: Record<string, unknown>) => e.team_id === null)).toBe(true);
		expect(body.data.some((e: Record<string, unknown>) => e.team_id === teamId)).toBe(true);
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
