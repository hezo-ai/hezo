import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { wsRoom } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import {
	type ContainerDeps,
	consumeFinalMemoryLine,
	type ProjectRow,
	provisionContainer,
	stopContainerGracefully,
	syncAllContainerStatuses,
} from '../src/services/containers';
import type { DockerClient } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { WebSocketManager } from '../src/services/ws';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';

function deps(docker: DockerClient, wsManager?: WebSocketManager): ContainerDeps {
	return { db, docker, dataDir: '/tmp/hezo-test-unused', wsManager };
}

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await createTestTeam(db, {
		name: 'Container Sync Co',

		template_id: teamTemplateId,
	});
	teamId = (await teamRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('syncAllContainerStatuses', () => {
	it('does nothing when no projects have containers', async () => {
		await db.query('UPDATE projects SET container_id = NULL');
		const mockDocker = createStubDocker({ inspectContainer: vi.fn() });
		await syncAllContainerStatuses(deps(mockDocker));
		expect(mockDocker.inspectContainer).not.toHaveBeenCalled();
	});

	it('sets status to error when container does not exist in Docker', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Ghost Container Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query(
			"UPDATE projects SET container_id = 'fake-container-id', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue(null),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{ container_status: string; container_id: string | null }>(
			'SELECT container_status, container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('error');
		expect(result.rows[0].container_id).toBeNull();
	});

	it('sets container_error with a helpful message when container is removed', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Removed Container Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		await new Promise((r) => setTimeout(r, 100));
		await db.query(
			"UPDATE projects SET container_id = 'gone', container_status = 'running'::container_status, container_error = NULL WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue(null),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{ container_error: string | null }>(
			'SELECT container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_error).toContain('no longer exists');
	});

	it('captures container_last_logs and records container_error when transitioning from running to stopped', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Exit Capture Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		await new Promise((r) => setTimeout(r, 100));
		await db.query(
			"UPDATE projects SET container_id = 'capture-1', container_status = 'running'::container_status, container_last_logs = NULL WHERE id = $1",
			[projectId],
		);

		// Encode a Docker multiplexed log frame containing "crash stack trace line"
		const body = 'crash stack trace line\n';
		const payload = new TextEncoder().encode(body);
		const frame = new Uint8Array(8 + payload.length);
		frame[0] = 1; // stdout
		frame[4] = (payload.length >> 24) & 0xff;
		frame[5] = (payload.length >> 16) & 0xff;
		frame[6] = (payload.length >> 8) & 0xff;
		frame[7] = payload.length & 0xff;
		frame.set(payload, 8);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				Id: 'capture-1',
				State: { Running: false, Status: 'exited', ExitCode: 137 },
			}),
			containerLogs: vi.fn().mockResolvedValue({
				arrayBuffer: async () => frame.buffer,
			}),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{
			container_status: string;
			container_error: string | null;
			container_last_logs: string | null;
		}>(
			'SELECT container_status, container_error, container_last_logs FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
		expect(result.rows[0].container_error).toContain('exited with code 137');
		expect(result.rows[0].container_last_logs).toContain('crash stack trace line');
		expect(mockDocker.containerLogs).toHaveBeenCalledTimes(1);
	});

	it('leaves container_status untouched on transport errors', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Transport Err Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'transient', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockRejectedValue(new Error('EPIPE')),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{ container_status: string; container_id: string | null }>(
			'SELECT container_status, container_id FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('running');
		expect(result.rows[0].container_id).toBe('transient');
	});

	it('updates status to stopped when container exists but is not running', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Stopped Container Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query(
			"UPDATE projects SET container_id = 'stopped-container', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: false, Status: 'exited' },
			}),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
	});

	it('keeps status as running when container is actually running', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Running Container Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query(
			"UPDATE projects SET container_id = 'running-container', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('running');
	});

	it('broadcasts changes when status changes', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Broadcast Test Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		await db.query(
			"UPDATE projects SET container_id = 'broadcast-container', container_status = 'running' WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue(null),
		});
		const mockWsManager = { broadcast: vi.fn() } as any;

		await syncAllContainerStatuses(deps(mockDocker, mockWsManager));

		expect(mockWsManager.broadcast).toHaveBeenCalled();
		const [room, event] = mockWsManager.broadcast.mock.calls.find(
			([r]: [string]) => r === wsRoom.team(teamId),
		) || [null, null];
		expect(room).toBeTruthy();
		expect(event.type).toBe('row_change');
		expect(event.table).toBe('projects');
		expect(event.action).toBe('UPDATE');
	});

	it('does not broadcast when status is unchanged', async () => {
		// Clear all container_ids from previous tests so only this project is synced
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'No Broadcast Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;

		// Wait for the async provisionContainer to complete (it will fail in test env)
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'stable-container', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
		});
		const mockWsManager = { broadcast: vi.fn() } as any;

		await syncAllContainerStatuses(deps(mockDocker, mockWsManager));

		expect(mockWsManager.broadcast).not.toHaveBeenCalled();
	});

	it('auto-stops a running container that exceeds the default memory limit', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Memory Hog Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'memory-hog-container', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);

		const overLimitBytes = 17 * 1024 ** 3;
		const stopContainer = vi.fn().mockResolvedValue(undefined);
		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
			containerStats: vi.fn().mockResolvedValue({
				usedBytes: overLimitBytes,
				rawUsageBytes: overLimitBytes,
			}),
			stopContainer,
			containerLogs: vi.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(0) }),
		});
		const mockWsManager = { broadcast: vi.fn() } as any;

		await syncAllContainerStatuses(deps(mockDocker, mockWsManager));

		expect(stopContainer).toHaveBeenCalledWith('memory-hog-container');

		const result = await db.query<{ container_status: string; container_error: string | null }>(
			'SELECT container_status, container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('error');
		expect(result.rows[0].container_error).toContain('17.00 GiB');
		expect(result.rows[0].container_error).toContain('16 GiB');
		expect(result.rows[0].container_error).toMatch(/restart/i);

		expect(mockWsManager.broadcast).toHaveBeenCalled();
	});

	it('honors a per-project memory_limit_gib override and interpolates it into the error', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Tighter Limit Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			`UPDATE projects
			 SET container_id = 'tight-container',
			     container_status = 'running'::container_status,
			     memory_limit_gib = 8
			 WHERE id = $1`,
			[projectId],
		);

		const usageBytes = 9 * 1024 ** 3;
		const stopContainer = vi.fn().mockResolvedValue(undefined);
		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
			containerStats: vi.fn().mockResolvedValue({
				usedBytes: usageBytes,
				rawUsageBytes: usageBytes,
			}),
			stopContainer,
			containerLogs: vi.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(0) }),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		expect(stopContainer).toHaveBeenCalledWith('tight-container');

		const result = await db.query<{ container_status: string; container_error: string | null }>(
			'SELECT container_status, container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('error');
		expect(result.rows[0].container_error).toContain('9.00 GiB');
		expect(result.rows[0].container_error).toContain('8 GiB');
	});

	it('leaves a running container untouched when memory is within budget', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Memory Frugal Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'frugal-container', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);

		const stopContainer = vi.fn().mockResolvedValue(undefined);
		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
			containerStats: vi.fn().mockResolvedValue({
				usedBytes: 4 * 1024 ** 3,
				rawUsageBytes: 4 * 1024 ** 3,
			}),
			stopContainer,
		});

		await syncAllContainerStatuses(deps(mockDocker));

		expect(stopContainer).not.toHaveBeenCalled();

		const result = await db.query<{ container_status: string; container_error: string | null }>(
			'SELECT container_status, container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('running');
		expect(result.rows[0].container_error).toBeNull();
	});

	it('records the running→stopped transition cleanly when the container is removed before log capture', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Log Race Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'race-1', container_status = 'running'::container_status, container_last_logs = NULL WHERE id = $1",
			[projectId],
		);
		consumeFinalMemoryLine(projectId);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				Id: 'race-1',
				State: { Running: false, Status: 'exited', ExitCode: 137 },
			}),
			containerLogs: vi.fn().mockResolvedValue(null),
		});

		await expect(syncAllContainerStatuses(deps(mockDocker))).resolves.not.toThrow();

		const result = await db.query<{
			container_status: string;
			container_error: string | null;
			container_last_logs: string | null;
		}>(
			'SELECT container_status, container_error, container_last_logs FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
		expect(result.rows[0].container_error).toContain('exited with code 137');
		expect(result.rows[0].container_last_logs).toBeNull();
	});

	it('does not poll stats for stopped containers', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Already Stopped Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'already-stopped', container_status = 'stopped'::container_status WHERE id = $1",
			[projectId],
		);

		const containerStats = vi.fn();
		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: false, Status: 'exited', ExitCode: 0 },
			}),
			containerStats,
		});

		await syncAllContainerStatuses(deps(mockDocker));

		expect(containerStats).not.toHaveBeenCalled();
	});

	it('records the last memory reading and appends it to container_last_logs on exit', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Memory Trail Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			`UPDATE projects
			 SET container_id = 'memory-trail',
			     container_status = 'running'::container_status,
			     container_last_logs = NULL,
			     memory_limit_gib = 16
			 WHERE id = $1`,
			[projectId],
		);
		consumeFinalMemoryLine(projectId);

		const inspectContainer = vi
			.fn()
			.mockResolvedValueOnce({ State: { Running: true, Status: 'running' } })
			.mockResolvedValueOnce({
				Id: 'memory-trail',
				State: { Running: false, Status: 'exited', ExitCode: 137 },
			});
		const usedBytes = 4 * 1024 ** 3;
		const mockDocker = createStubDocker({
			inspectContainer,
			containerStats: vi.fn().mockResolvedValue({ usedBytes, rawUsageBytes: usedBytes }),
			containerLogs: vi.fn().mockResolvedValue(null),
		});

		await syncAllContainerStatuses(deps(mockDocker));
		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{
			container_status: string;
			container_error: string | null;
			container_last_logs: string | null;
		}>(
			'SELECT container_status, container_error, container_last_logs FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
		expect(result.rows[0].container_error).toContain('exited with code 137');
		expect(result.rows[0].container_last_logs).toContain('→ Final container memory: 4.00 / 16 GiB');
		expect(consumeFinalMemoryLine(projectId)).toBeNull();
	});

	it('honors the per-project memory limit when formatting the final-memory line', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Tighter Trail Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			`UPDATE projects
			 SET container_id = 'tight-trail',
			     container_status = 'running'::container_status,
			     memory_limit_gib = 8,
			     container_last_logs = NULL
			 WHERE id = $1`,
			[projectId],
		);
		consumeFinalMemoryLine(projectId);

		const inspectContainer = vi
			.fn()
			.mockResolvedValueOnce({ State: { Running: true, Status: 'running' } })
			.mockResolvedValueOnce({
				Id: 'tight-trail',
				State: { Running: false, Status: 'exited', ExitCode: 0 },
			});
		const usedBytes = 2.5 * 1024 ** 3;
		const mockDocker = createStubDocker({
			inspectContainer,
			containerStats: vi.fn().mockResolvedValue({ usedBytes, rawUsageBytes: usedBytes }),
			containerLogs: vi.fn().mockResolvedValue(null),
		});

		await syncAllContainerStatuses(deps(mockDocker));
		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{ container_last_logs: string | null }>(
			'SELECT container_last_logs FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_last_logs).toContain('→ Final container memory: 2.50 / 8 GiB');
	});

	it('skips the final-memory line on exit when stats were never observed', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'No Stats Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'no-stats', container_status = 'running'::container_status, container_last_logs = NULL WHERE id = $1",
			[projectId],
		);
		consumeFinalMemoryLine(projectId);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				Id: 'no-stats',
				State: { Running: false, Status: 'exited', ExitCode: 1 },
			}),
			containerLogs: vi.fn().mockResolvedValue(null),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		const result = await db.query<{ container_last_logs: string | null }>(
			'SELECT container_last_logs FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_last_logs).toBeNull();
	});

	it('clears the memory readout after a memory-limit auto-stop so the next exit does not double-emit', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Auto Stop Trail Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'auto-stop-trail', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		consumeFinalMemoryLine(projectId);

		const overLimitBytes = 17 * 1024 ** 3;
		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
			containerStats: vi.fn().mockResolvedValue({
				usedBytes: overLimitBytes,
				rawUsageBytes: overLimitBytes,
			}),
			stopContainer: vi.fn().mockResolvedValue(undefined),
			containerLogs: vi.fn().mockResolvedValue(null),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		expect(consumeFinalMemoryLine(projectId)).toBeNull();
	});

	it('survives a stats transport error without stopping the container', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL, container_error = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Stats Flake Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'flake-container', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);

		const stopContainer = vi.fn().mockResolvedValue(undefined);
		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
			containerStats: vi.fn().mockRejectedValue(new Error('EPIPE')),
			stopContainer,
		});

		await syncAllContainerStatuses(deps(mockDocker));

		expect(stopContainer).not.toHaveBeenCalled();
		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('running');
	});
});

describe('provisionContainer broadcasting', () => {
	let projectId: string;

	beforeAll(async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Provision Broadcast Project',
			description: 'Test project.',
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

	it('broadcasts creating then running row_changes on successful provisioning', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const mockDocker = createStubDocker({
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'test-container-123' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
		});
		const mockWsManager = { broadcast: vi.fn() } as any;

		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		await provisionContainer(
			{ db, docker: mockDocker, dataDir, wsManager: mockWsManager },
			project,
			'container-sync-co',
		);

		// The creating broadcast must precede the docker work — it is what shows
		// the provisioning banner for rebuilds launched outside the rebuild route
		// (startup stale-mount repair, self-heal, missing-container reprovision).
		expect(mockWsManager.broadcast).toHaveBeenCalledTimes(2);
		const [creatingRoom, creatingEvent] = mockWsManager.broadcast.mock.calls[0];
		expect(creatingRoom).toBe(wsRoom.team(teamId));
		expect(creatingEvent.type).toBe('row_change');
		expect(creatingEvent.table).toBe('projects');
		expect(creatingEvent.action).toBe('UPDATE');
		expect(creatingEvent.row.container_status).toBe('creating');

		const [room, event] = mockWsManager.broadcast.mock.calls[1];
		expect(room).toBe(wsRoom.team(teamId));
		expect(event.type).toBe('row_change');
		expect(event.table).toBe('projects');
		expect(event.action).toBe('UPDATE');
		expect(event.row.container_status).toBe('running');
		expect(event.row.container_id).toBe('test-container-123');

		const hostConfig = mockDocker.createContainer.mock.calls[0][1].HostConfig;
		const binds = hostConfig.Binds as string[];
		const assetsBind = binds.find((b) => b.endsWith(':/workspace/.hezo/assets:ro'));
		expect(assetsBind).toBeDefined();
		expect(assetsBind).toContain(
			`${dataDir}/teams/${project.team_id}/projects/${project.id}/assets`,
		);

		expect(hostConfig.Memory).toBeUndefined();
		expect(hostConfig.MemorySwap).toBeUndefined();
	});

	it('keeps bind mounts stable on rename; container name adopts the new slug', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const makeMockDocker = () =>
			createStubDocker({
				imageExists: vi.fn().mockResolvedValue(false),
				pullImage: vi.fn().mockResolvedValue(undefined),
				createContainer: vi.fn().mockResolvedValue({ Id: 'renamed-container' }),
				startContainer: vi.fn().mockResolvedValue(undefined),
			});

		const createRes = await createTestProject(db, teamId, {
			name: 'Rename Target',
			description: 'Rename invariance test.',
		});
		const renameProjectId = (await createRes.json()).data.id;
		await db.query(
			"UPDATE projects SET container_id = NULL, container_status = NULL, docker_base_image = 'test-unregistered:latest' WHERE id = $1",
			[renameProjectId],
		);

		const before = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [renameProjectId])
		).rows[0];

		const dockerBefore = makeMockDocker();
		await provisionContainer({ db, docker: dockerBefore, dataDir }, before, 'container-sync-co');
		const nameBefore = dockerBefore.createContainer.mock.calls[0][0];
		const bindsBefore = dockerBefore.createContainer.mock.calls[0][1].HostConfig.Binds as string[];

		// Rename the project — exactly what the PATCH handler does (new name + new slug).
		await db.query(
			'UPDATE projects SET name = $1, slug = $2, container_id = NULL, container_status = NULL WHERE id = $3',
			['Renamed Project', 'renamed-project-slug', renameProjectId],
		);

		const after = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [renameProjectId])
		).rows[0];
		expect(after.slug).toBe('renamed-project-slug');
		expect(after.slug).not.toBe(before.slug);

		const dockerAfter = makeMockDocker();
		await provisionContainer({ db, docker: dockerAfter, dataDir }, after, 'container-sync-co');
		const nameAfter = dockerAfter.createContainer.mock.calls[0][0];
		const bindsAfter = dockerAfter.createContainer.mock.calls[0][1].HostConfig.Binds as string[];

		// Name embeds the slug for `docker ps` readability (rename changes it) plus
		// a random suffix so a retained old container never blocks the new name.
		expect(nameBefore).toMatch(
			new RegExp(`^hezo-${before.slug}-${renameProjectId.slice(0, 8)}-[0-9a-f]+$`),
		);
		expect(nameAfter).toMatch(
			new RegExp(`^hezo-renamed-project-slug-${renameProjectId.slice(0, 8)}-[0-9a-f]+$`),
		);
		expect(nameAfter).not.toBe(nameBefore);

		// Bind mounts key on the immutable id, so paths stay stable across rename.
		expect(bindsAfter).toEqual(bindsBefore);
		expect(bindsAfter.join('\n')).toContain(`/projects/${renameProjectId}/`);
		expect(bindsAfter.join('\n')).not.toContain(before.slug);
		expect(bindsAfter.join('\n')).not.toContain('renamed-project-slug');
	});

	it('bind-mounts the egress CA when egressCAPath is provided', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
			[projectId],
		);

		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const egressCAPath = join(dataDir, 'ca.pem');
		const mockDocker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
			createContainer: vi.fn().mockResolvedValue({ Id: 'egress-ca-container' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
			execCreate: vi.fn().mockResolvedValue('exec-id'),
			execStart: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
		} as any;

		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		await provisionContainer(
			{ db, docker: mockDocker, dataDir, egressCAPath },
			project,
			'container-sync-co',
		);

		const binds = mockDocker.createContainer.mock.calls[0][1].HostConfig.Binds as string[];
		expect(binds).toContain(`${egressCAPath}:/usr/local/share/ca-certificates/hezo-egress.crt:ro`);
		expect(mockDocker.execCreate).toHaveBeenCalled();
	});

	// A recording docker that answers the run-user probe from `users` and records
	// every exec, so a test can assert the in-container ownership chowns.
	function provisionRecordingDocker(users: Record<string, { uid: number; gid: number }>) {
		const execs: { Cmd: string[]; User?: string }[] = [];
		const byId = new Map<string, string[]>();
		let seq = 0;
		const docker = createStubDocker({
			imageExists: vi.fn().mockResolvedValue(true),
			createContainer: vi.fn().mockResolvedValue({ Id: 'runuser-cid' }),
			startContainer: vi.fn().mockResolvedValue(undefined),
			execCreate: vi.fn(async (_id: string, config: { Cmd: string[]; User?: string }) => {
				execs.push(config);
				const id = `e-${seq++}`;
				byId.set(id, config.Cmd);
				return id;
			}),
			execStart: vi.fn(async (id: string) => {
				const m = byId.get(id)?.[2]?.match(/^id -u (\S+) &&/);
				const u = m ? users[m[1]] : users.__default;
				if (byId.get(id)?.[2]?.startsWith('id -u')) {
					return u
						? { stdout: `${u.uid}\n${u.gid}\n${m ? m[1] : '__default'}\n`, stderr: '' }
						: { stdout: '', stderr: 'no such user' };
				}
				return { stdout: '', stderr: '' };
			}),
			execInspect: vi.fn(async (id: string) => {
				const script = byId.get(id)?.[2] ?? '';
				const m = script.match(/^id -u (\S+) &&/);
				const known = script.startsWith('id -u') ? (m ? !!users[m[1]] : !!users.__default) : true;
				return { ExitCode: known ? 0 : 1, Running: false, Pid: 0 };
			}),
		});
		return { docker, execs };
	}

	it('chowns the bind-mount dirs + /run/hezo to the detected run-user', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
			[projectId],
		);
		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const { docker, execs } = provisionRecordingDocker({ node: { uid: 1000, gid: 1000 } });
		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		await provisionContainer({ db, docker, dataDir }, project, 'container-sync-co');

		const chown = execs.find((e) => e.Cmd?.[2]?.startsWith('chown'));
		expect(chown).toBeDefined();
		expect(chown?.User).toBe('root'); // chown runs in-container as root
		expect(chown?.Cmd[2]).toContain("'node':'node'");
		expect(chown?.Cmd[2]).toContain('/workspace');
		expect(chown?.Cmd[2]).toContain('/worktrees');
		expect(chown?.Cmd[2]).toContain('/run/hezo');
	});

	it('runs as root with no chown for a custom image without a node user', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
			[projectId],
		);
		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		// No `node`; the container default user is root.
		const { docker, execs } = provisionRecordingDocker({ __default: { uid: 0, gid: 0 } });
		const project = (
			await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
		).rows[0];

		await provisionContainer({ db, docker, dataDir }, project, 'container-sync-co');

		expect(execs.some((e) => e.Cmd?.[2]?.startsWith('chown'))).toBe(false);
	});

	it('broadcasts row_change on provisioning error', async () => {
		// Reset status
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
			[projectId],
		);

		const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
		const mockDocker = createStubDocker({
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockRejectedValue(new Error('Image not found')),
		});
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

		expect(mockWsManager.broadcast).toHaveBeenCalledTimes(2);
		expect(mockWsManager.broadcast.mock.calls[0][1].row.container_status).toBe('creating');
		const [room, event] = mockWsManager.broadcast.mock.calls[1];
		expect(room).toBe(wsRoom.team(teamId));
		expect(event.type).toBe('row_change');
		expect(event.table).toBe('projects');
		expect(event.action).toBe('UPDATE');
		expect(event.row.container_status).toBe('error');

		const stored = await db.query<{ container_error: string | null }>(
			'SELECT container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(stored.rows[0].container_error).toContain('Image not found');
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
		const projectRes = await createTestProject(db, teamId, {
			name: 'Stop Test Project',
			description: 'Test project.',
		});
		projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));
	});

	it('sets status to stopped and broadcasts on success', async () => {
		await db.query(
			"UPDATE projects SET container_id = 'stop-test-container', container_status = 'stopping'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			stopContainer: vi.fn().mockResolvedValue(undefined),
		});
		const mockWsManager = { broadcast: vi.fn() } as any;

		await stopContainerGracefully(
			{ db, docker: mockDocker, dataDir: '', wsManager: mockWsManager },
			projectId,
			'stop-test-project',
			teamId,
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
		expect(room).toBe(wsRoom.team(teamId));
		expect(event.type).toBe('row_change');
		expect(event.row.container_status).toBe('stopped');
	});

	it('sets status to error and broadcasts when Docker stop fails', async () => {
		await db.query(
			"UPDATE projects SET container_id = 'fail-stop-container', container_status = 'stopping'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			stopContainer: vi.fn().mockRejectedValue(new Error('Docker daemon error')),
		});
		const mockWsManager = { broadcast: vi.fn() } as any;

		await stopContainerGracefully(
			{ db, docker: mockDocker, dataDir: '', wsManager: mockWsManager },
			projectId,
			'stop-test-project',
			teamId,
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

		const mockDocker = createStubDocker({
			stopContainer: vi.fn().mockResolvedValue(undefined),
		});

		await stopContainerGracefully(
			{ db, docker: mockDocker, dataDir: '' },
			projectId,
			'stop-test-project',
			teamId,
			'no-ws-stop',
		);

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
	});

	it('appends the final-memory line when the sync loop has observed stats', async () => {
		const projectRes = await createTestProject(db, teamId, {
			name: 'Graceful Stop Trail Project',
			description: 'Test project.',
		});
		const stopProjectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			`UPDATE projects
			 SET container_id = 'graceful-trail',
			     container_status = 'running'::container_status,
			     container_last_logs = NULL,
			     memory_limit_gib = 16
			 WHERE id = $1`,
			[stopProjectId],
		);
		consumeFinalMemoryLine(stopProjectId);

		const usedBytes = 6 * 1024 ** 3;
		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: true, Status: 'running' },
			}),
			containerStats: vi.fn().mockResolvedValue({ usedBytes, rawUsageBytes: usedBytes }),
			stopContainer: vi.fn().mockResolvedValue(undefined),
			containerLogs: vi.fn().mockResolvedValue(null),
		});

		await syncAllContainerStatuses(deps(mockDocker));

		await stopContainerGracefully(
			{ db, docker: mockDocker, dataDir: '' },
			stopProjectId,
			'graceful-trail-project',
			teamId,
			'graceful-trail',
		);

		const result = await db.query<{ container_last_logs: string | null }>(
			'SELECT container_last_logs FROM projects WHERE id = $1',
			[stopProjectId],
		);
		expect(result.rows[0].container_last_logs).toContain('→ Final container memory: 6.00 / 16 GiB');
	});
});

describe('syncAllContainerStatuses with stopping status', () => {
	it('resolves stopping status to stopped when container is not running', async () => {
		await db.query(
			'UPDATE projects SET container_id = NULL, container_status = NULL WHERE team_id = $1',
			[teamId],
		);

		const projectRes = await createTestProject(db, teamId, {
			name: 'Stopping Sync Project',
			description: 'Test project.',
		});
		const projectId = (await projectRes.json()).data.id;
		await new Promise((r) => setTimeout(r, 100));

		await db.query(
			"UPDATE projects SET container_id = 'stopping-sync-container', container_status = 'stopping'::container_status WHERE id = $1",
			[projectId],
		);

		const mockDocker = createStubDocker({
			inspectContainer: vi.fn().mockResolvedValue({
				State: { Running: false, Status: 'exited' },
			}),
		});
		const mockWsManager = { broadcast: vi.fn() } as any;

		await syncAllContainerStatuses(deps(mockDocker, mockWsManager));

		const result = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(result.rows[0].container_status).toBe('stopped');
		expect(mockWsManager.broadcast).toHaveBeenCalled();
	});
});
