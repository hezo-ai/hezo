import type { PGlite } from '@electric-sql/pglite';
import { AuthType, WsMessageType } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerLogStreamer } from '../../services/container-logs';
import type { DockerClient } from '../../services/docker';
import { LogStreamBroker } from '../../services/log-stream-broker';
import { WebSocketManager, type WsData, type WsSocket } from '../../services/ws';
import { handleWsSubscribe, handleWsUnsubscribe } from '../../services/ws-subscribe-handler';
import { safeClose } from '../helpers';
import { createTestDbWithMigrations } from '../helpers/db';

function createMockWs(auth: WsData['auth']): WsSocket & { _sent: string[] } {
	const sent: string[] = [];
	return {
		data: {
			auth,
			rooms: new Set<string>(),
		},
		send(msg: string) {
			sent.push(msg);
		},
		_sent: sent,
	};
}

async function seedCompanyWithProject(
	db: PGlite,
	opts: { container_status?: 'running' | 'stopped' | null; container_id?: string | null } = {},
) {
	const user = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('U', false) RETURNING id",
	);
	const userId = user.rows[0].id;
	const company = await db.query<{ id: string }>(
		"INSERT INTO companies (name, slug, issue_prefix) VALUES ('C', 'c', 'CCC') RETURNING id",
	);
	const companyId = company.rows[0].id;
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (company_id, member_type, display_name)
		 VALUES ($1, 'user', 'M') RETURNING id`,
		[companyId],
	);
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'member')`, [
		member.rows[0].id,
		userId,
	]);

	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (company_id, name, slug, container_id, container_status)
		 VALUES ($1, 'P', 'p', $2, $3::container_status) RETURNING id`,
		[companyId, opts.container_id ?? null, opts.container_status ?? null],
	);
	return { userId, companyId, projectId: project.rows[0].id };
}

function canAccessCompanyFactory(db: PGlite) {
	return async (auth: WsData['auth'], companyId: string): Promise<boolean> => {
		if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
			return auth.companyId === companyId;
		}
		if (auth.type === AuthType.Board) {
			if (auth.isSuperuser) return true;
			const result = await db.query(
				'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.company_id = $2',
				[auth.userId, companyId],
			);
			return result.rows.length > 0;
		}
		return false;
	};
}

describe('handleWsSubscribe', () => {
	let db: PGlite;
	let wsManager: WebSocketManager;
	let containerLogStreamer: ContainerLogStreamer;
	let logs: LogStreamBroker;
	const mockDocker = {} as DockerClient;

	beforeEach(async () => {
		db = await createTestDbWithMigrations();
		wsManager = new WebSocketManager();
		containerLogStreamer = new ContainerLogStreamer();
		logs = new LogStreamBroker();
		logs.setWsManager(wsManager);
	});

	afterEach(async () => {
		containerLogStreamer.stopAll(logs);
		await safeClose(db);
	});

	function deps(overrides: Partial<Parameters<typeof handleWsSubscribe>[2]> = {}) {
		return {
			db,
			wsManager,
			docker: mockDocker,
			containerLogStreamer,
			logs,
			canAccessCompany: canAccessCompanyFactory(db),
			sendToSocket: (_ws: WsSocket, _payload: unknown) => {},
			...overrides,
		};
	}

	it('subscribes a board member to project-runs and delivers broadcasts', async () => {
		const { userId, projectId } = await seedCompanyWithProject(db);
		const ws = createMockWs({ type: AuthType.Board, userId });

		await handleWsSubscribe(ws, `project-runs:${projectId}`, deps());

		expect(wsManager.getRoomSize(`project-runs:${projectId}`)).toBe(1);
		wsManager.broadcast(`project-runs:${projectId}`, {
			type: WsMessageType.RunLog,
			projectId,
			runId: 'r1',
			stream: 'stdout',
			text: 'hi',
		});
		expect(ws._sent).toHaveLength(1);
		expect(JSON.parse(ws._sent[0]).text).toBe('hi');
	});

	it('rejects project-runs subscribe for a user without company access', async () => {
		const { projectId } = await seedCompanyWithProject(db);
		const other = await db.query<{ id: string }>(
			"INSERT INTO users (display_name) VALUES ('Other') RETURNING id",
		);
		const ws = createMockWs({ type: AuthType.Board, userId: other.rows[0].id });

		await handleWsSubscribe(ws, `project-runs:${projectId}`, deps());

		expect(wsManager.getRoomSize(`project-runs:${projectId}`)).toBe(0);
		wsManager.broadcast(`project-runs:${projectId}`, { type: 'x' });
		expect(ws._sent).toHaveLength(0);
	});

	it('ignores project-runs subscribe for a non-existent project', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const user = await db.query<{ id: string }>(
			"INSERT INTO users (display_name) VALUES ('U') RETURNING id",
		);
		const ws = createMockWs({ type: AuthType.Board, userId: user.rows[0].id });

		await expect(handleWsSubscribe(ws, `project-runs:${fakeId}`, deps())).resolves.toBeUndefined();
		expect(wsManager.getRoomSize(`project-runs:${fakeId}`)).toBe(0);
	});

	it('subscribes an agent whose companyId matches', async () => {
		const { companyId, projectId } = await seedCompanyWithProject(db);
		const ws = createMockWs({ type: AuthType.Agent, companyId, memberId: 'm1' });

		await handleWsSubscribe(ws, `project-runs:${projectId}`, deps());

		expect(wsManager.getRoomSize(`project-runs:${projectId}`)).toBe(1);
	});

	it('rejects an agent whose companyId does not match', async () => {
		const { projectId } = await seedCompanyWithProject(db);
		const ws = createMockWs({
			type: AuthType.Agent,
			companyId: '00000000-0000-0000-0000-000000000000',
			memberId: 'm1',
		});

		await handleWsSubscribe(ws, `project-runs:${projectId}`, deps());

		expect(wsManager.getRoomSize(`project-runs:${projectId}`)).toBe(0);
	});

	it('subscribes a board member to company room when canAccessCompany passes', async () => {
		const { userId, companyId } = await seedCompanyWithProject(db);
		const ws = createMockWs({ type: AuthType.Board, userId });

		await handleWsSubscribe(ws, `company:${companyId}`, deps());

		expect(wsManager.getRoomSize(`company:${companyId}`)).toBe(1);
	});

	it('subscribes to container-logs and replays buffered logs for that room', async () => {
		const { userId, projectId } = await seedCompanyWithProject(db);
		const ws = createMockWs({ type: AuthType.Board, userId });

		logs.begin({
			streamId: `provision:${projectId}`,
			room: `container-logs:${projectId}`,
			buildMessage: (line) => ({
				type: WsMessageType.ContainerLog,
				projectId,
				stream: line.stream,
				text: line.text,
			}),
		});
		logs.emit(`provision:${projectId}`, 'stdout', 'replayed line\n');

		const sendToSocket = vi.fn((_s: WsSocket, _payload: unknown) => {});

		await handleWsSubscribe(ws, `container-logs:${projectId}`, deps({ sendToSocket }));

		expect(wsManager.getRoomSize(`container-logs:${projectId}`)).toBe(1);
		expect(sendToSocket).toHaveBeenCalledWith(ws, {
			type: WsMessageType.ContainerLog,
			projectId,
			stream: 'stdout',
			text: 'replayed line',
		});
	});

	it('replays buffered run logs when subscribing to project-runs', async () => {
		const { userId, projectId } = await seedCompanyWithProject(db);
		const ws = createMockWs({ type: AuthType.Board, userId });

		const runId = 'run-abc';
		logs.begin({
			streamId: `run:${runId}`,
			room: `project-runs:${projectId}`,
			buildMessage: (line) => ({
				type: WsMessageType.RunLog,
				projectId,
				runId,
				issueId: null,
				stream: line.stream,
				text: line.text,
			}),
		});
		logs.emit(`run:${runId}`, 'stdout', 'first\nsecond\n');

		const sendToSocket = vi.fn((_s: WsSocket, _payload: unknown) => {});

		await handleWsSubscribe(ws, `project-runs:${projectId}`, deps({ sendToSocket }));

		expect(wsManager.getRoomSize(`project-runs:${projectId}`)).toBe(1);
		expect(sendToSocket).toHaveBeenCalledTimes(2);
		expect(sendToSocket).toHaveBeenNthCalledWith(1, ws, {
			type: WsMessageType.RunLog,
			projectId,
			runId,
			issueId: null,
			stream: 'stdout',
			text: 'first',
		});
		expect(sendToSocket).toHaveBeenNthCalledWith(2, ws, {
			type: WsMessageType.RunLog,
			projectId,
			runId,
			issueId: null,
			stream: 'stdout',
			text: 'second',
		});
	});
});

describe('handleWsUnsubscribe', () => {
	it('unsubscribes from a room', () => {
		const wsManager = new WebSocketManager();
		const containerLogStreamer = new ContainerLogStreamer();
		const logs = new LogStreamBroker();
		const ws = createMockWs({ type: AuthType.Board, userId: 'u1' });

		wsManager.subscribe(ws, 'company:abc');
		handleWsUnsubscribe(ws, 'company:abc', { wsManager, containerLogStreamer, logs });

		expect(wsManager.getRoomSize('company:abc')).toBe(0);
	});

	it('stops container log streamer when last subscriber leaves container-logs room', () => {
		const wsManager = new WebSocketManager();
		const containerLogStreamer = new ContainerLogStreamer();
		const logs = new LogStreamBroker();
		const stopSpy = vi.spyOn(containerLogStreamer, 'unsubscribe');
		const ws = createMockWs({ type: AuthType.Board, userId: 'u1' });

		wsManager.subscribe(ws, 'container-logs:proj-1');
		handleWsUnsubscribe(ws, 'container-logs:proj-1', {
			wsManager,
			containerLogStreamer,
			logs,
		});

		expect(stopSpy).toHaveBeenCalledWith('proj-1', logs);
	});
});
