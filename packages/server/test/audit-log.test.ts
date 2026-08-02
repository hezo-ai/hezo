import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { auditLog } from '../src/lib/audit';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
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

	// An archive/restore row records the run's task in `details.task_id`, which is
	// what the route's join onto tasks reads — so the feed deep-links the row to
	// the task whose run did it, with no extra column.
	it('resolves ref_task_identifier from an archive row task_id', async () => {
		const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Curator' }),
		});
		const agentId = (await agentRes.json()).data.id as string;

		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title: 'Curation run', assignee_id: agentId }),
		});
		expect(taskRes.status).toBe(201);
		const task = (await taskRes.json()).data as { id: string; identifier: string };

		await auditLog(db, {
			projectId,
			actorType: 'agent',
			actorMemberId: null,
			action: 'updated',
			entityType: 'asset',
			entityId: null,
			details: { filename: 'reports/q3.html', archived: false, task_id: task.id, run_id: 'r1' },
		});

		const res = await app.request(`/api/projects/${projectSlug}/audit-log?entity_type=asset`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		const entry = body.data.find(
			(e: Record<string, unknown>) =>
				(e.details as Record<string, unknown>)?.filename === 'reports/q3.html',
		);
		expect(entry).toBeDefined();
		expect(entry.ref_task_identifier).toBe(task.identifier);
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

	it('walks every row exactly once across cursor pages', async () => {
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

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		// Rows share a created_at to the millisecond here, so this also proves the
		// id tiebreak keeps the seek total - without it a page boundary landing
		// mid-timestamp would drop or repeat rows.
		do {
			const url = `/api/projects/${projectSlug}/audit-log?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
			const res = await app.request(url, { headers: authHeader(token) });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data.length).toBeLessThanOrEqual(2);
			expect(body.meta.has_more).toBe(typeof body.meta.next_cursor === 'string');
			for (const row of body.data) seen.push(row.id as string);
			cursor = body.meta.next_cursor;
			pages++;
			expect(pages).toBeLessThan(20);
		} while (cursor);

		expect(pages).toBeGreaterThan(1);
		expect(seen.length).toBeGreaterThanOrEqual(5);
		expect(new Set(seen).size).toBe(seen.length);

		// The walk must match a single unpaginated read of the same feed.
		const all = await app.request(`/api/projects/${projectSlug}/audit-log?limit=200`, {
			headers: authHeader(token),
		});
		const allBody = await all.json();
		expect(allBody.meta.has_more).toBe(false);
		expect(seen).toEqual(allBody.data.map((e: Record<string, unknown>) => e.id));
	});

	it('rejects a malformed cursor instead of silently restarting the feed', async () => {
		// Both halves land in a typed SQL comparison, so a bad one would otherwise
		// 500 on the cast; and quietly falling back to page 1 would replay rows the
		// client already has with no way to tell that from a real result.
		for (const cursor of [
			'garbage',
			'2026-01-01T00:00:00.000Z|not-a-uuid',
			'nope|' + crypto.randomUUID(),
		]) {
			const res = await app.request(
				`/api/projects/${projectSlug}/audit-log?cursor=${encodeURIComponent(cursor)}`,
				{ headers: authHeader(token) },
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error.code).toBe('invalid_cursor');
		}
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
