import { DEFAULT_TEAM_ID, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import type { ContainerLogStreamer } from './container-logs';
import type { ContainerEngine } from './docker';
import type { ImageBuildTracker } from './image-build-tracker';
import type { LogStreamBroker } from './log-stream-broker';
import type { WebSocketManager, WsData, WsSocket } from './ws';

export interface WsSubscribeDeps {
	db: Db | null;
	wsManager: WebSocketManager;
	docker: ContainerEngine | null;
	containerLogStreamer: ContainerLogStreamer;
	logs: LogStreamBroker | null;
	imageBuildTracker: ImageBuildTracker | null;
	canAccessTeam: (auth: WsData['auth'], teamId: string) => Promise<boolean>;
	sendToSocket: (ws: WsSocket, payload: unknown) => void;
}

export async function handleWsSubscribe(
	ws: WsSocket,
	room: string,
	deps: WsSubscribeDeps,
): Promise<void> {
	// The single global CEO chat room: gated on HQ-team access (superuser or HQ member).
	if (room === wsRoom.chat()) {
		const allowed = await deps.canAccessTeam(ws.data.auth, DEFAULT_TEAM_ID);
		if (!allowed) return;
		deps.wsManager.subscribe(ws, room);
		return;
	}

	// The single global base-image build room. Progress of a shared base image
	// isn't team-scoped, so any authenticated socket may watch it; replay the
	// current in-flight builds so a mid-build subscriber sees the bar at once.
	if (room === wsRoom.imageBuilds()) {
		deps.wsManager.subscribe(ws, room);
		deps.imageBuildTracker?.replay((payload) => deps.sendToSocket(ws, payload));
		return;
	}

	// The single global project-index room. Its messages carry only an "index
	// changed" signal (no row data), and the refetch they trigger
	// (`GET /api/projects`) is itself authorized per team, so any authenticated
	// socket may watch it without leaking a project it can't see.
	if (room === wsRoom.projects()) {
		deps.wsManager.subscribe(ws, room);
		return;
	}

	const teamMatch = room.match(/^team:(.+)$/);
	if (teamMatch) {
		const allowed = await deps.canAccessTeam(ws.data.auth, teamMatch[1]);
		if (!allowed) return;
		deps.wsManager.subscribe(ws, room);
		return;
	}

	const logsMatch = room.match(/^container-logs:(.+)$/);
	if (logsMatch && deps.db && deps.docker) {
		// The room names a **container**, so the project has to be resolved from it
		// to run the team check. Both representations are asked, in the order that
		// makes the newer one win: a pool member is the authoritative record, and
		// `projects.container_id` still names a container during provisioning before
		// its member row exists.
		const containerId = logsMatch[1];
		const owner = await deps.db.query<{ project_id: string; team_id: string; live: boolean }>(
			`SELECT p.id AS project_id, p.team_id,
			        m.state IN ('idle', 'busy') AS live
			   FROM container_pool_members m JOIN projects p ON p.id = m.project_id
			  WHERE m.container_id = $1
			  UNION
			 SELECT p.id, p.team_id, p.container_status = 'running'
			   FROM projects p WHERE p.container_id = $1
			  LIMIT 1`,
			[containerId],
		);
		const row = owner.rows[0];
		// An unknown container is refused rather than subscribed to an empty room:
		// a client watching a room nothing will ever publish to looks identical to
		// one watching a quiet container.
		if (!row) return;
		const allowed = await deps.canAccessTeam(ws.data.auth, row.team_id);
		if (!allowed) return;

		deps.wsManager.subscribe(ws, room);
		// Only a container that is actually up gets a follow stream: a stopped one
		// has nothing to emit, and attaching to it is an engine call that can only
		// fail. It can no longer *erase* anything - the follow stream and the
		// provisioning trace are one stream now (see `containerStreamId`) - but
		// there is still no reason to open it.
		if (deps.logs && row.live) {
			deps.containerLogStreamer.subscribe(row.project_id, containerId, deps.logs, deps.docker);
		}
		deps.logs?.replay(room, (payload) => {
			deps.sendToSocket(ws, payload);
		});
		return;
	}

	const runsMatch = room.match(/^project-runs:(.+)$/);
	if (runsMatch && deps.db) {
		const projectId = runsMatch[1];
		const project = await deps.db.query<{ team_id: string }>(
			'SELECT team_id FROM projects WHERE id = $1',
			[projectId],
		);
		if (project.rows.length === 0) return;
		const allowed = await deps.canAccessTeam(ws.data.auth, project.rows[0].team_id);
		if (!allowed) return;
		deps.wsManager.subscribe(ws, room);
		deps.logs?.replay(room, (payload) => {
			deps.sendToSocket(ws, payload);
		});
		return;
	}
}

export function handleWsUnsubscribe(
	ws: WsSocket,
	room: string,
	deps: Pick<WsSubscribeDeps, 'wsManager' | 'containerLogStreamer' | 'logs'>,
): void {
	deps.wsManager.unsubscribe(ws, room);
	const logsMatch = room.match(/^container-logs:(.+)$/);
	if (logsMatch && deps.wsManager.getRoomSize(room) === 0) {
		deps.containerLogStreamer.unsubscribe(logsMatch[1], deps.logs ?? undefined);
	}
}
