import { WsMessageType, type WsRowChangeMessage, wsRoom } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSocket } from '../contexts/socket-context';

const TABLE_TO_QUERY_KEY: Record<
	string,
	(companyId: string, row: Record<string, unknown>) => string[][]
> = {
	issues: (cid) => [
		['companies', cid, 'issues'],
		['companies', cid],
		['companies'],
		['companies', cid, 'projects'],
	],
	heartbeat_runs: (cid, row) => {
		const keys: string[][] = [['companies', cid, 'issues']];
		if (row.member_id) {
			keys.push(['companies', cid, 'agents', row.member_id as string, 'heartbeat-runs']);
			if (row.id) {
				keys.push([
					'companies',
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
	issue_comments: (cid) => [['companies', cid, 'issues']],
	member_agents: (cid) => [['companies', cid, 'agents']],
	projects: (cid) => [['companies', cid, 'projects']],
	approvals: (cid) => [['companies', cid, 'approvals']],
	notifications: (cid) => [
		['companies', cid, 'notifications'],
		['notifications', 'pending'],
	],
	documents: (cid, row) => {
		switch (row.type) {
			case 'project_doc':
				return [['companies', cid, 'projects']];
			case 'kb_doc':
				return [['companies', cid, 'kb-docs']];
			case 'company_preferences':
				return [['companies', cid, 'preferences']];
			default:
				return [];
		}
	},
	secrets: (cid) => [['companies', cid, 'secrets']],
	api_keys: (cid) => [['companies', cid, 'api-keys']],
	cost_entries: (cid) => [['companies', cid, 'costs']],
	execution_locks: (cid) => [['companies', cid, 'execution-locks']],
	repos: (cid) => [['companies', cid, 'projects']],
	goals: (cid) => [['companies', cid, 'goals']],
};

export function useWebSocket(wsCompanyId: string | undefined, routeCompanyId: string): void {
	const queryClient = useQueryClient();
	const { joinRoom, leaveRoom, subscribe } = useSocket();

	useEffect(() => {
		if (!wsCompanyId) return;
		const room = wsRoom.company(wsCompanyId);
		joinRoom(room);

		const unsubscribe = subscribe(WsMessageType.RowChange, (msg) => {
			const { table, row } = msg as WsRowChangeMessage;
			const keyMapper = TABLE_TO_QUERY_KEY[table];
			if (keyMapper) {
				const keys = keyMapper(routeCompanyId, row);
				for (const key of keys) {
					queryClient.invalidateQueries({ queryKey: key });
				}
			}
		});

		return () => {
			unsubscribe();
			leaveRoom(room);
		};
	}, [wsCompanyId, routeCompanyId, queryClient, joinRoom, leaveRoom, subscribe]);
}
