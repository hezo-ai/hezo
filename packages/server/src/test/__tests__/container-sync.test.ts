import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../lib/types';
import {
	type ProjectRow,
	provisionContainer,
	stopContainerGracefully,
	syncAllContainerStatuses,
} from '../../services/containers';
import { LogStreamBroker } from '../../services/log-stream-broker';
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
		await db.query('UPDATE projects SET container_id = NULL');
		const mockDocker = { inspectContainer: vi.fn() } as any;
		await syncAllContainerStatuses(db, mockDocker);
		expect(mockDocker.inspectContainer).not.toHaveBeenCalled();
	});

	it('sets status to error when container does not exist in Docker', async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Ghost Container Project', description: 'Test project.' }),
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
			body: JSON.stringify({ name: 'Stopped Container Project', description: 'Test project.' }),
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
			body: JSON.stringify({ name: 'Running Container Project', description: 'Test project.' }),
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
			body: JSON.stringify({ name: 'Broadcast Test Project', description: 'Test project.' }),
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
			body: JSON.stringify({ name: 'No Broadcast Project', description: 'Test project.' }),
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

describe('provisionContainer broadcasting', () => {
	let projectId: string;

	beforeAll(async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Provision Broadcast Project', description: 'Test project.' }),
		});
		projectId = (await projectRes.json()).data.id;

		// Wait for the async provisionContainer triggered by creation to settle
		await new Promise((r) => setTimeout(r, 100));

		// Reset status and use an image not in the local-build registry so ensureImage
		// routes through pullImage instead of attempting a real docker build.
		await db.query(
			"UPDATE projects SET container_id = NULL, container_status = NULL, docker_base_image = 'test-unregistered:latest' WHERE id = $1",
			[projectId],
		);
	});

	it('broadcasts row_change on successful provisioning', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const mockDocker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'test-container-123' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		} as any;
		const mockWsManager = { broadcast: vi.fn() } as any;

		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		await provisionContainer(
			{ db, docker: mockDocker, dataDir, wsManager: mockWsManager },
			project,
			'container-sync-co',
		);

		expect(mockWsManager.broadcast).toHaveBeenCalledTimes(1);
		const [room, event] = mockWsManager.broadcast.mock.calls[0];
		expect(room).toBe(`company:${companyId}`);
		expect(event.type).toBe('row_change');
		expect(event.table).toBe('projects');
		expect(event.action).toBe('UPDATE');
		expect(event.row.container_status).toBe('running');
		expect(event.row.container_id).toBe('test-container-123');
	});

	it('broadcasts row_change on provisioning error', async () => {
		// Reset status
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
			[projectId],
		);

		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const mockDocker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockRejectedValue(new Error('Image not found')),
		} as any;
		const mockWsManager = { broadcast: vi.fn() } as any;

		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		await expect(
			provisionContainer(
				{ db, docker: mockDocker, dataDir, wsManager: mockWsManager },
				project,
				'container-sync-co',
			),
		).rejects.toThrow('Image not found');

		expect(mockWsManager.broadcast).toHaveBeenCalledTimes(1);
		const [room, event] = mockWsManager.broadcast.mock.calls[0];
		expect(room).toBe(`company:${companyId}`);
		expect(event.type).toBe('row_change');
		expect(event.table).toBe('projects');
		expect(event.action).toBe('UPDATE');
		expect(event.row.container_status).toBe('error');
	});

	it('does not broadcast when wsManager is not provided', async () => {
		// Reset status
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
			[projectId],
		);

		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const mockDocker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'no-ws-container' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		} as any;

		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		// Should succeed without throwing, no broadcast
		const containerId = await provisionContainer(
			{ db, docker: mockDocker, dataDir },
			project,
			'container-sync-co',
		);
		expect(containerId).toBe('no-ws-container');
	});

	it('streams provisioning step lines through the provisioning log broadcaster', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
			[projectId],
		);

		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const mockDocker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'logs-container' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
			removeContainer: vi.fn().mockResolvedValue(undefined),
		} as any;
		const mockWsManager = { broadcast: vi.fn() } as any;
		const logs = new LogStreamBroker();
		logs.setWsManager(mockWsManager);

		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		await provisionContainer(
			{ db, docker: mockDocker, dataDir, wsManager: mockWsManager, logs },
			project,
			'container-sync-co',
		);

		const logRoom = `container-logs:${projectId}`;
		const logLines = mockWsManager.broadcast.mock.calls
			.filter(([room]: [string]) => room === logRoom)
			.map(([, event]: [string, any]) => event.text as string);

		expect(logLines).toEqual(
			expect.arrayContaining([
				expect.stringContaining('Preparing workspace'),
				expect.stringContaining('Resolving image'),
				expect.stringContaining('Creating container'),
				'→ Starting container',
				'✓ Container ready',
			]),
		);
	});

	it('emits a failure line through the provisioning log broadcaster on error', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
			[projectId],
		);

		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const mockDocker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockRejectedValue(new Error('boom')),
		} as any;
		const mockWsManager = { broadcast: vi.fn() } as any;
		const logs = new LogStreamBroker();
		logs.setWsManager(mockWsManager);

		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		await expect(
			provisionContainer(
				{ db, docker: mockDocker, dataDir, wsManager: mockWsManager, logs },
				project,
				'container-sync-co',
			),
		).rejects.toThrow('boom');

		const logRoom = `container-logs:${projectId}`;
		const logLines = mockWsManager.broadcast.mock.calls
			.filter(([room]: [string]) => room === logRoom)
			.map(([, event]: [string, any]) => event.text as string);

		expect(logLines.some((line: string) => line.includes('✗ Provisioning failed: boom'))).toBe(
			true,
		);
	});
});

describe('stopContainerGracefully', () => {
	let projectId: string;

	beforeAll(async () => {
		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Stop Test Project', description: 'Test project.' }),
		});
		projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));
	});

	it('sets status to stopped and broadcasts on success', async () => {
		await db.query(
			"UPDATE projects SET container_id = 'stop-test-container', container_status = 'stopping'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = { stopContainer: vi.fn().mockResolvedValue(undefined) } as any;
		const mockWsManager = { broadcast: vi.fn() } as any;

		await stopContainerGracefully(
			{ db, docker: mockDocker, dataDir: '', wsManager: mockWsManager },
			projectId,
			companyId,
			'stop-test-container',
		);

		expect(mockDocker.stopContainer).toHaveBeenCalledWith('stop-test-container');

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');

		expect(mockWsManager.broadcast).toHaveBeenCalledTimes(1);
		const [room, event] = mockWsManager.broadcast.mock.calls[0];
		expect(room).toBe(`company:${companyId}`);
		expect(event.type).toBe('row_change');
		expect(event.row.container_status).toBe('stopped');
	});

	it('sets status to error and broadcasts when Docker stop fails', async () => {
		await db.query(
			"UPDATE projects SET container_id = 'fail-stop-container', container_status = 'stopping'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = {
			stopContainer: vi.fn().mockRejectedValue(new Error('Docker daemon error')),
		} as any;
		const mockWsManager = { broadcast: vi.fn() } as any;

		await stopContainerGracefully(
			{ db, docker: mockDocker, dataDir: '', wsManager: mockWsManager },
			projectId,
			companyId,
			'fail-stop-container',
		);

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('error');

		expect(mockWsManager.broadcast).toHaveBeenCalledTimes(1);
		const [, event] = mockWsManager.broadcast.mock.calls[0];
		expect(event.row.container_status).toBe('error');
	});

	it('does not broadcast when wsManager is not provided', async () => {
		await db.query(
			"UPDATE projects SET container_id = 'no-ws-stop', container_status = 'stopping'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = { stopContainer: vi.fn().mockResolvedValue(undefined) } as any;

		await stopContainerGracefully(
			{ db, docker: mockDocker, dataDir: '' },
			projectId,
			companyId,
			'no-ws-stop',
		);

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
	});
});

describe('syncAllContainerStatuses with stopping status', () => {
	it('resolves stopping status to stopped when container is not running', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE company_id = $1',
			[companyId],
		);

		const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Stopping Sync Project', description: 'Test project.' }),
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'stopping-sync-container', container_status = 'stopping'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = {
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: false, Status: 'exited' },
			}),
		} as any;
		const mockWsManager = { broadcast: vi.fn() } as any;

		await syncAllContainerStatuses(db, mockDocker, mockWsManager);

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
		expect(mockWsManager.broadcast).toHaveBeenCalled();
	});
});
