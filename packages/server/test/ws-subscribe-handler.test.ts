import type { PGlite } from '@electric-sql/pglite';
import { AuthType, WsMessageType, wsRoom } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthInfo } from '../src/lib/types';
import { canAuthAccessTeam } from '../src/middleware/auth';
import { ContainerLogStreamer } from '../src/services/container-logs';
import type { DockerClient } from '../src/services/docker';
import { ImageBuildTracker } from '../src/services/image-build-tracker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { WebSocketManager, type WsData, type WsSocket } from '../src/services/ws';
import { handleWsSubscribe, handleWsUnsubscribe } from '../src/services/ws-subscribe-handler';
import { safeClose } from './helpers';
import { createTestDbWithMigrations } from './helpers/db';

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

async function seedTeamWithProject(
	db: PGlite,
	opts: { container_status?: 'running' | 'stopped' | null; container_id?: string | null } = {},
) {
	const user = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('U', false) RETURNING id",
	);
	const userId = user.rows[0].id;
	const team = await db.query<{ id: string }>(
		"INSERT INTO teams (name, slug) VALUES ('C', 'c') RETURNING id",
	);
	const teamId = team.rows[0].id;
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'user', 'M') RETURNING id`,
		[teamId],
	);
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'member')`, [
		member.rows[0].id,
		userId,
	]);

	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix, container_id, container_status)
		 VALUES ($1, 'P', 'p', 'P', $2, $3::container_status) RETURNING id`,
		[teamId, opts.container_id ?? null, opts.container_status ?? null],
	);
	return { userId, teamId, projectId: project.rows[0].id };
}

function canAccessTeamFactory(db: PGlite) {
	// Delegate to the production predicate instead of re-implementing it, so this
	// mock can't drift from the real team-access rule. WsData widens AuthInfo to a
	// loose bag (the production `canAccessTeam` re-narrows the same way).
	return (auth: WsData['auth'], teamId: string): Promise<boolean> =>
		canAuthAccessTeam(db, auth as AuthInfo, teamId);
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
			imageBuildTracker: null,
			canAccessTeam: canAccessTeamFactory(db),
			sendToSocket: (_ws: WsSocket, _payload: unknown) => {},
			...overrides,
		};
	}

	it('subscribes a the admin to project-runs and delivers broadcasts', async () => {
		const { userId, projectId } = await seedTeamWithProject(db);
		const ws = createMockWs({ type: AuthType.Admin, userId });

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

	it('rejects project-runs subscribe for a user without team access', async () => {
		const { projectId } = await seedTeamWithProject(db);
		const other = await db.query<{ id: string }>(
			"INSERT INTO users (display_name) VALUES ('Other') RETURNING id",
		);
		const ws = createMockWs({ type: AuthType.Admin, userId: other.rows[0].id });

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
		const ws = createMockWs({ type: AuthType.Admin, userId: user.rows[0].id });

		await expect(handleWsSubscribe(ws, `project-runs:${fakeId}`, deps())).resolves.toBeUndefined();
		expect(wsManager.getRoomSize(`project-runs:${fakeId}`)).toBe(0);
	});

	it('subscribes an agent whose teamId matches', async () => {
		const { teamId, projectId } = await seedTeamWithProject(db);
		const ws = createMockWs({ type: AuthType.Agent, teamId, memberId: 'm1' });

		await handleWsSubscribe(ws, `project-runs:${projectId}`, deps());

		expect(wsManager.getRoomSize(`project-runs:${projectId}`)).toBe(1);
	});

	it('rejects an agent whose teamId does not match', async () => {
		const { projectId } = await seedTeamWithProject(db);
		const ws = createMockWs({
			type: AuthType.Agent,
			teamId: '00000000-0000-0000-0000-000000000000',
			memberId: 'm1',
		});

		await handleWsSubscribe(ws, `project-runs:${projectId}`, deps());

		expect(wsManager.getRoomSize(`project-runs:${projectId}`)).toBe(0);
	});

	it('subscribes a the admin to team room when canAccessTeam passes', async () => {
		const { userId, teamId } = await seedTeamWithProject(db);
		const ws = createMockWs({ type: AuthType.Admin, userId });

		await handleWsSubscribe(ws, wsRoom.team(teamId), deps());

		expect(wsManager.getRoomSize(wsRoom.team(teamId))).toBe(1);
	});

	it('subscribes an approved API key to a team room (admin-equivalent)', async () => {
		const { teamId } = await seedTeamWithProject(db);
		// An API key belongs to no team membership, but is admin-equivalent and
		// cross-team — it must still reach realtime rooms.
		const auth: AuthInfo = {
			type: AuthType.ApiKey,
			apiKeyId: 'ak-1',
			isSuperuser: true,
			crossTeam: true,
		};
		const ws = createMockWs(auth);

		await handleWsSubscribe(ws, wsRoom.team(teamId), deps());

		expect(wsManager.getRoomSize(wsRoom.team(teamId))).toBe(1);
	});

	it('subscribes to the global image-builds room and replays in-flight builds', async () => {
		const user = await db.query<{ id: string }>(
			"INSERT INTO users (display_name) VALUES ('U') RETURNING id",
		);
		const ws = createMockWs({ type: AuthType.Admin, userId: user.rows[0].id });
		const imageBuildTracker = new ImageBuildTracker();
		imageBuildTracker.setWsManager(wsManager);
		imageBuildTracker.start('hezo/agent-base:latest');
		imageBuildTracker.observe('hezo/agent-base:latest', 'Step 2/4 : RUN x');

		// The current snapshot is delivered via sendToSocket on subscribe.
		const replayed: unknown[] = [];
		await handleWsSubscribe(
			ws,
			wsRoom.imageBuilds(),
			deps({ imageBuildTracker, sendToSocket: (_ws, payload) => replayed.push(payload) }),
		);

		expect(wsManager.getRoomSize(wsRoom.imageBuilds())).toBe(1);
		expect(replayed).toHaveLength(1);
		expect(replayed[0]).toMatchObject({
			type: WsMessageType.ImageBuild,
			image: 'hezo/agent-base:latest',
			status: 'building',
			percent: 50,
		});

		// Subsequent live broadcasts reach the now-subscribed socket.
		imageBuildTracker.finish('hezo/agent-base:latest');
		const lastRaw = ws._sent[ws._sent.length - 1];
		expect(JSON.parse(lastRaw)).toMatchObject({
			type: WsMessageType.ImageBuild,
			status: 'done',
			percent: 100,
		});
	});

	it('subscribes to container-logs and replays buffered logs for that room', async () => {
		const { userId, projectId } = await seedTeamWithProject(db);
		const ws = createMockWs({ type: AuthType.Admin, userId });

		logs.begin({
			streamId: `provision:${projectId}`,
			room: `container-logs:${projectId}`,
			buildMessage: (line) => ({
				type: WsMessageType.ContainerLog,
				projectId,
				stream: line.stream,
				text: line.text,
			}),
			buildSnapshot: (text) => ({
				type: WsMessageType.ContainerLog,
				projectId,
				stream: 'stdout',
				text,
				replace: true,
			}),
		});
		logs.emit(`provision:${projectId}`, 'stdout', 'replayed line\n');

		const sendToSocket = vi.fn((_s: WsSocket, _payload: unknown) => {});

		await handleWsSubscribe(ws, `container-logs:${projectId}`, deps({ sendToSocket }));

		expect(wsManager.getRoomSize(`container-logs:${projectId}`)).toBe(1);
		expect(sendToSocket).toHaveBeenCalledTimes(1);
		expect(sendToSocket).toHaveBeenCalledWith(ws, {
			type: WsMessageType.ContainerLog,
			projectId,
			stream: 'stdout',
			text: 'replayed line\n',
			replace: true,
		});
	});

	it('replays buffered run logs as a single snapshot when subscribing to project-runs', async () => {
		const { userId, projectId } = await seedTeamWithProject(db);
		const ws = createMockWs({ type: AuthType.Admin, userId });

		const runId = 'run-abc';
		logs.begin({
			streamId: `run:${runId}`,
			room: `project-runs:${projectId}`,
			buildMessage: (line) => ({
				type: WsMessageType.RunLog,
				projectId,
				runId,
				taskId: null,
				stream: line.stream,
				text: line.text,
			}),
			buildSnapshot: (text) => ({
				type: WsMessageType.RunLog,
				projectId,
				runId,
				taskId: null,
				stream: 'stdout',
				text,
				replace: true,
			}),
		});
		logs.emit(`run:${runId}`, 'stdout', 'first\nsecond\n');

		const sendToSocket = vi.fn((_s: WsSocket, _payload: unknown) => {});

		await handleWsSubscribe(ws, `project-runs:${projectId}`, deps({ sendToSocket }));

		expect(wsManager.getRoomSize(`project-runs:${projectId}`)).toBe(1);
		expect(sendToSocket).toHaveBeenCalledTimes(1);
		expect(sendToSocket).toHaveBeenCalledWith(ws, {
			type: WsMessageType.RunLog,
			projectId,
			runId,
			taskId: null,
			stream: 'stdout',
			text: 'first\nsecond\n',
			replace: true,
		});
	});
});

describe('handleWsUnsubscribe', () => {
	it('unsubscribes from a room', () => {
		const wsManager = new WebSocketManager();
		const containerLogStreamer = new ContainerLogStreamer();
		const logs = new LogStreamBroker();
		const ws = createMockWs({ type: AuthType.Admin, userId: 'u1' });

		wsManager.subscribe(ws, 'team:abc');
		handleWsUnsubscribe(ws, 'team:abc', { wsManager, containerLogStreamer, logs });

		expect(wsManager.getRoomSize('team:abc')).toBe(0);
	});

	it('stops container log streamer when last subscriber leaves container-logs room', () => {
		const wsManager = new WebSocketManager();
		const containerLogStreamer = new ContainerLogStreamer();
		const logs = new LogStreamBroker();
		const stopSpy = vi.spyOn(containerLogStreamer, 'unsubscribe');
		const ws = createMockWs({ type: AuthType.Admin, userId: 'u1' });

		wsManager.subscribe(ws, 'container-logs:proj-1');
		handleWsUnsubscribe(ws, 'container-logs:proj-1', {
			wsManager,
			containerLogStreamer,
			logs,
		});

		expect(stopSpy).toHaveBeenCalledWith('proj-1', logs);
	});
});
