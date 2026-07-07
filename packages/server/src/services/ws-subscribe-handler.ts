import { DEFAULT_TEAM_ID, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import type { ContainerLogStreamer } from './container-logs';
import type { DockerClient } from './docker';
import type { ImageBuildTracker } from './image-build-tracker';
import type { LogStreamBroker } from './log-stream-broker';
import type { WebSocketManager, WsData, WsSocket } from './ws';

export interface WsSubscribeDeps {
	db: Db | null;
	wsManager: WebSocketManager;
	docker: DockerClient | null;
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
		const projectId = logsMatch[1];
		const project = await deps.db.query<{
			container_id: string | null;
			team_id: string;
			container_status: string | null;
		}>('SELECT container_id, team_id, container_status FROM projects WHERE id = $1', [projectId]);
		if (project.rows.length === 0) return;
		const row = project.rows[0];
		const allowed = await deps.canAccessTeam(ws.data.auth, row.team_id);
		if (!allowed) return;

		deps.wsManager.subscribe(ws, room);
		if (row.container_id && row.container_status === 'running' && deps.logs) {
			deps.containerLogStreamer.subscribe(projectId, row.container_id, deps.logs, deps.docker);
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
