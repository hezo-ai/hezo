import type { PGlite } from '@electric-sql/pglite';
import type { ContainerLogStreamer } from './container-logs';
import type { DockerClient } from './docker';
import type { LogStreamBroker } from './log-stream-broker';
import type { WebSocketManager, WsData, WsSocket } from './ws';

export interface WsSubscribeDeps {
	db: PGlite | null;
	wsManager: WebSocketManager;
	docker: DockerClient | null;
	containerLogStreamer: ContainerLogStreamer;
	logs: LogStreamBroker | null;
	canAccessTeam: (auth: WsData['auth'], teamId: string) => Promise<boolean>;
	sendToSocket: (ws: WsSocket, payload: unknown) => void;
}

export async function handleWsSubscribe(
	ws: WsSocket,
	room: string,
	deps: WsSubscribeDeps,
): Promise<void> {
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
