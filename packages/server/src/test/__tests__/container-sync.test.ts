import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../lib/types';
import { syncAllContainerStatuses } from '../../services/containers';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let companyId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const companyTypeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Container Sync Co',
			issue_prefix: 'CSC',
			template_id: companyTypeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('syncAllContainerStatuses', () => {
	it('does nothing when no projects have containers', async () => {
		const mockDocker = { inspectContainer: vi.fn() } as any;
		await syncAllContainerStatuses(db, mockDocker);
		expect(mockDocker.inspectContainer).not.toHaveBeenCalled();
	});

	it('sets status to error when container does not exist in Docker', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Ghost Container Project' }),
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query(
			"UPDATE projects SET container_id = 'fake-container-id', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const mockDocker = {
			inspectContainer: vi.fn().mockRejectedValue(new Error('No such container')),
		} as any;

		await syncAllContainerStatuses(db, mockDocker);

		const result = await db.query<{ container_status: string; container_id: string | null }>(
			'SELECT container_status, container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('error');
		expect(result.rows[0].container_id).toBeNull();
	});

	it('updates status to stopped when container exists but is not running', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Stopped Container Project' }),
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query(
			"UPDATE projects SET container_id = 'stopped-container', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const mockDocker = {
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: false, Status: 'exited' },
			}),
		} as any;

		await syncAllContainerStatuses(db, mockDocker);

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
	});

	it('keeps status as running when container is actually running', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Running Container Project' }),
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query(
			"UPDATE projects SET container_id = 'running-container', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const mockDocker = {
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
		} as any;

		await syncAllContainerStatuses(db, mockDocker);

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('running');
	});

	it('broadcasts changes when status changes', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Broadcast Test Project' }),
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query(
			"UPDATE projects SET container_id = 'broadcast-container', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const mockDocker = {
			inspectContainer: vi.fn().mockRejectedValue(new Error('No such container')),
		} as any;
		const mockWsManager = { broadcast: vi.fn() } as any;

		await syncAllContainerStatuses(db, mockDocker, mockWsManager);

		expect(mockWsManager.broadcast).toHaveBeenCalled();
		const [room, event] = mockWsManager.broadcast.mock.calls.find(
			([r]: [string]) => r === `company:${companyId}`,
		) || [null, null];
		expect(room).toBeTruthy();
		expect(event.type).toBe('row_change');
		expect(event.table).toBe('projects');
		expect(event.action).toBe('UPDATE');
	});

	it('does not broadcast when status is unchanged', async () => {
		// Clear all container_ids from previous tests so only this project is synced
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE company_id = $1',
			[companyId],
		);

		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Broadcast Project' }),
		});
		const projectId = (await projectRes.json()).data.id;

		// Wait for the async provisionContainer to complete (it will fail in test env)
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'stable-container', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = {
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
		} as any;
		const mockWsManager = { broadcast: vi.fn() } as any;

		await syncAllContainerStatuses(db, mockDocker, mockWsManager);

		expect(mockWsManager.broadcast).not.toHaveBeenCalled();
	});
});
