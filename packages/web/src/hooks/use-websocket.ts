import { WsMessageType, type WsRowChangeMessage } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSocket } from '../contexts/socket-context';

const TABLE_TO_QUERY_KEY: Record<
	string,
	(companyId: string, row: Record<string, unknown>) => string[][]
> = {
	issues: (cid) => [['companies', cid, 'issues']],
	issue_comments: (cid, row) => [
		['companies', cid, 'issues'],
		...(row.issue_id ? [['companies', cid, 'issues', row.issue_id as string, 'comments']] : []),
	],
	member_agents: (cid) => [['companies', cid, 'agents']],
	projects: (cid) => [['companies', cid, 'projects']],
	approvals: (cid) => [['companies', cid, 'approvals']],
	kb_docs: (cid) => [['companies', cid, 'kb-docs']],
	company_preferences: (cid) => [['companies', cid, 'preferences']],
	secrets: (cid) => [['companies', cid, 'secrets']],
	api_keys: (cid) => [['companies', cid, 'api-keys']],
	cost_entries: (cid) => [['companies', cid, 'costs']],
	execution_locks: (cid) => [['companies', cid, 'execution-locks']],
	repos: (cid) => [['companies', cid, 'projects']],
};

export function useWebSocket(wsCompanyId: string, routeCompanyId: string): void {
	const queryClient = useQueryClient();
	const { joinRoom, leaveRoom, subscribe } = useSocket();

	useEffect(() => {
		const room = `company:${wsCompanyId}`;
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
