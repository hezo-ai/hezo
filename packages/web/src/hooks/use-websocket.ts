import { WsMessageType, type WsRowChangeMessage, wsRoom } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSocket } from '../contexts/socket-context';

const TABLE_TO_QUERY_KEY: Record<
	string,
	(teamId: string, row: Record<string, unknown>) => string[][]
> = {
	issues: (cid) => [
		['teams', cid, 'issues'],
		['teams', cid],
		['teams'],
		['teams', cid, 'projects'],
	],
	heartbeat_runs: (cid, row) => {
		const keys: string[][] = [['teams', cid, 'issues']];
		if (row.member_id) {
			keys.push(['teams', cid, 'agents', row.member_id as string, 'heartbeat-runs']);
			if (row.id) {
				keys.push([
					'teams',
					cid,
					'agents',
					row.member_id as string,
					'heartbeat-runs',
					row.id as string,
				]);
			}
		}
		return keys;
	},
	issue_comments: (cid) => [['teams', cid, 'issues']],
	comment_reactions: (cid) => [['teams', cid, 'issues']],
	comment_attachments: (cid) => [['teams', cid, 'issues']],
	member_agents: (cid) => [['teams', cid, 'agents']],
	projects: (cid) => [['teams', cid, 'projects']],
	approvals: (cid) => [['teams', cid, 'approvals']],
	documents: (cid, row) => {
		switch (row.type) {
			case 'project_doc':
				return [['teams', cid, 'projects']];
			case 'kb_doc':
				return [['teams', cid, 'kb-docs']];
			case 'team_preferences':
				return [['teams', cid, 'preferences']];
			default:
				return [];
		}
	},
	secrets: (cid) => [['teams', cid, 'secrets']],
	api_keys: (cid) => [['teams', cid, 'api-keys']],
	cost_entries: (cid) => [['teams', cid, 'costs']],
	execution_locks: (cid) => [['teams', cid, 'execution-locks']],
	repos: (cid) => [['teams', cid, 'projects']],
	goals: (cid) => [['teams', cid, 'goals']],
};

export function useWebSocket(wsTeamId: string | undefined, routeTeamId: string): void {
	const queryClient = useQueryClient();
	const { joinRoom, leaveRoom, subscribe } = useSocket();

	useEffect(() => {
		if (!wsTeamId) return;
		const room = wsRoom.team(wsTeamId);
		joinRoom(room);

		const unsubscribe = subscribe(WsMessageType.RowChange, (msg) => {
			const { table, row } = msg as WsRowChangeMessage;
			const keyMapper = TABLE_TO_QUERY_KEY[table];
			if (keyMapper) {
				const keys = keyMapper(routeTeamId, row);
				for (const key of keys) {
					queryClient.invalidateQueries({ queryKey: key });
				}
			}
		});

		return () => {
			unsubscribe();
			leaveRoom(room);
		};
	}, [wsTeamId, routeTeamId, queryClient, joinRoom, leaveRoom, subscribe]);
}
