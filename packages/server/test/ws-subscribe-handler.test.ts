import { AuthType, WsMessageType, wsRoom } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import type { AuthInfo } from '../src/lib/types';
import { canAuthAccessTeam } from '../src/middleware/auth';
import { ContainerLogStreamer, containerStreamId } from '../src/services/container-logs';
import { ImageBuildTracker } from '../src/services/image-build-tracker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ContainerEngine } from '../src/services/sandbox/types';
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
	db: Db,
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

function canAccessTeamFactory(db: Db) {
	// Delegate to the production predicate instead of re-implementing it, so this
	// mock can't drift from the real team-access rule. WsData widens AuthInfo to a
	// loose bag (the production `canAccessTeam` re-narrows the same way).
	return (auth: WsData['auth'], teamId: string): Promise<boolean> =>
		canAuthAccessTeam(db, auth as AuthInfo, teamId);
}

describe('handleWsSubscribe', () => {
	let db: Db;
	let wsManager: WebSocketManager;
	let containerLogStreamer: ContainerLogStreamer;
	let logs: LogStreamBroker;
	const mockDocker = {} as ContainerEngine;

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

	/**
	 * Open a container's log stream the way `provisionContainer` does - the same
	 * id, so the test cannot drift from what the handler will find.
	 */
	function beginContainerStream(containerId: string, projectId: string) {
		logs.begin({
			streamId: containerStreamId(containerId),
			room: wsRoom.containerLogs(containerId),
			buildMessage: (line) => ({
				type: WsMessageType.ContainerLog,
				containerId,
				projectId,
				stream: line.stream,
				text: line.text,
			}),
			buildSnapshot: (text) => ({
				type: WsMessageType.ContainerLog,
				containerId,
				projectId,
				stream: 'stdout',
				text,
				replace: true,
			}),
		});
	}

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

	it('subscribes any authenticated socket to the global projects room', async () => {
		// A board user who is a member of no team must still watch the project
		// index: the signal carries no row data and the refetch it triggers is
		// authorized per team, so this can't leak a project they can't see.
		const user = await db.query<{ id: string }>(
			"INSERT INTO users (display_name) VALUES ('U') RETURNING id",
		);
		const ws = createMockWs({ type: AuthType.Admin, userId: user.rows[0].id });

		await handleWsSubscribe(ws, wsRoom.projects(), deps());

		expect(wsManager.getRoomSize(wsRoom.projects())).toBe(1);

		// A live signal reaches the now-subscribed socket.
		wsManager.broadcast(wsRoom.projects(), { type: WsMessageType.ProjectsChanged });
		expect(ws._sent).toHaveLength(1);
		expect(JSON.parse(ws._sent[0]).type).toBe(WsMessageType.ProjectsChanged);
	});

	it('subscribes to container-logs and replays buffered logs for that room', async () => {
		// The room names a container, not its project - so the handler has to
		// resolve the owner before it can run the team check at all.
		const containerId = 'ctr-live';
		const { userId, projectId } = await seedTeamWithProject(db, { container_id: containerId });
		const ws = createMockWs({ type: AuthType.Admin, userId });

		beginContainerStream(containerId, projectId);
		logs.emit(containerStreamId(containerId), 'stdout', 'replayed line\n');

		const sendToSocket = vi.fn((_s: WsSocket, _payload: unknown) => {});

		await handleWsSubscribe(ws, wsRoom.containerLogs(containerId), deps({ sendToSocket }));

		expect(wsManager.getRoomSize(wsRoom.containerLogs(containerId))).toBe(1);
		expect(sendToSocket).toHaveBeenCalledTimes(1);
		expect(sendToSocket).toHaveBeenCalledWith(ws, {
			type: WsMessageType.ContainerLog,
			containerId,
			projectId,
			stream: 'stdout',
			text: 'replayed line\n',
			replace: true,
		});
	});

	it('resolves a container recorded only as a pool member, and follows it while it is up', async () => {
		// The other half of the dual representation: once provisioning finishes the
		// member row is the authoritative record, and a handler reading only
		// `projects.container_id` would refuse the very containers a run is using.
		const containerId = 'ctr-pooled';
		const { userId, projectId } = await seedTeamWithProject(db);
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state, disk_ceiling_bytes)
			 VALUES ($1, $2, 'idle', 1000000)`,
			[projectId, containerId],
		);
		const ws = createMockWs({ type: AuthType.Admin, userId });
		const followed: string[] = [];
		const docker = {
			containerLogs: async (id: string) => {
				followed.push(id);
				return new Response(new ReadableStream({ start: (c) => c.close() }));
			},
		} as unknown as ContainerEngine;

		await handleWsSubscribe(ws, wsRoom.containerLogs(containerId), deps({ docker }));

		expect(wsManager.getRoomSize(wsRoom.containerLogs(containerId))).toBe(1);
		expect(followed).toEqual([containerId]);
	});

	it('does not open a follow stream for a container that is not running', async () => {
		// A suspended container has nothing to emit, and a second stream in this
		// room replays an *empty* replace-snapshot that wipes the provisioning
		// output the client was just sent.
		const containerId = 'ctr-suspended';
		const { userId, projectId } = await seedTeamWithProject(db);
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state, disk_ceiling_bytes)
			 VALUES ($1, $2, 'suspended', 1000000)`,
			[projectId, containerId],
		);
		const ws = createMockWs({ type: AuthType.Admin, userId });
		const followed: string[] = [];
		const docker = {
			containerLogs: async (id: string) => {
				followed.push(id);
				return new Response(new ReadableStream({ start: (c) => c.close() }));
			},
		} as unknown as ContainerEngine;

		await handleWsSubscribe(ws, wsRoom.containerLogs(containerId), deps({ docker }));

		expect(wsManager.getRoomSize(wsRoom.containerLogs(containerId))).toBe(1);
		expect(followed).toEqual([]);
	});

	it('keeps the provisioning trace when it follows a container that is up', async () => {
		// The regression this exists for. An `idle` container is live, so the
		// handler starts a follow stream on it - and a container's own log is empty
		// on every backend (PID 1 is `sleep infinity`) and absent on a managed one.
		// While that follow stream was a *second* stream in the room, replay sent
		// two `replace: true` snapshots carrying the same containerId and the empty
		// one landed last, so a container that had finished coming up read as "No
		// output was captured from this container". One stream per container makes
		// that impossible: exactly one snapshot, and it has the trace in it.
		const containerId = 'ctr-idle';
		const { userId, projectId } = await seedTeamWithProject(db);
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state, disk_ceiling_bytes)
			 VALUES ($1, $2, 'idle', 1000000)`,
			[projectId, containerId],
		);
		beginContainerStream(containerId, projectId);
		logs.emit(containerStreamId(containerId), 'stdout', '→ Creating container\n');

		const ws = createMockWs({ type: AuthType.Admin, userId });
		const followed: string[] = [];
		// Returning null is Daytona's answer, by design: it exposes no container
		// log at all, so this stream can never contribute a line.
		const docker = {
			containerLogs: async (id: string) => {
				followed.push(id);
				return null;
			},
		} as unknown as ContainerEngine;
		const sendToSocket = vi.fn((_s: WsSocket, _payload: unknown) => {});

		await handleWsSubscribe(ws, wsRoom.containerLogs(containerId), deps({ docker, sendToSocket }));

		expect(followed).toEqual([containerId]);
		expect(sendToSocket).toHaveBeenCalledTimes(1);
		expect(sendToSocket).toHaveBeenCalledWith(ws, {
			type: WsMessageType.ContainerLog,
			containerId,
			projectId,
			stream: 'stdout',
			text: '→ Creating container\n',
			replace: true,
		});
	});

	it('keeps a container log across viewers coming and going', async () => {
		// Closing the page used to `end` the stream, which discarded the trace: the
		// log belongs to the container, not to whoever happens to be watching it.
		const containerId = 'ctr-revisited';
		const { projectId } = await seedTeamWithProject(db);
		beginContainerStream(containerId, projectId);
		logs.emit(containerStreamId(containerId), 'stdout', '→ Starting container\n');

		containerLogStreamer.subscribe(projectId, containerId, logs, {
			containerLogs: async () => null,
		} as unknown as ContainerEngine);
		containerLogStreamer.unsubscribe(containerId, logs);

		expect(logs.getLogText(containerStreamId(containerId))).toContain('→ Starting container');

		// Destroying the container is what ends it - and what bounds the map.
		await containerLogStreamer.end(containerId, logs);
		expect(logs.isActive(containerStreamId(containerId))).toBe(false);
	});

	it('refuses a container this instance does not own', async () => {
		// Subscribing to a room nothing will ever publish to is indistinguishable
		// from watching a quiet container, so an unknown id is refused outright.
		const { userId } = await seedTeamWithProject(db);
		const ws = createMockWs({ type: AuthType.Admin, userId });

		await handleWsSubscribe(ws, wsRoom.containerLogs('ctr-nobody'), deps());

		expect(wsManager.getRoomSize(wsRoom.containerLogs('ctr-nobody'))).toBe(0);
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
