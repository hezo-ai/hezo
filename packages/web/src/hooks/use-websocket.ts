import { WsMessageType, type WsRowChangeMessage } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';

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

export function useWebSocket(companyId: string): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		const token = api.getToken();
		if (!token) return;

		if (!wsClient.connected) {
			wsClient.connect(token);
		}

		const room = `company:${companyId}`;
		wsClient.subscribe(room);

		const unsubscribe = wsClient.on(WsMessageType.RowChange, (msg) => {
			const { table, row } = msg as WsRowChangeMessage;
			const keyMapper = TABLE_TO_QUERY_KEY[table];
			if (keyMapper) {
				const keys = keyMapper(companyId, row);
				for (const key of keys) {
					queryClient.invalidateQueries({ queryKey: key });
				}
			}
		});

		return () => {
			unsubscribe();
			wsClient.unsubscribe(room);
		};
	}, [companyId, queryClient]);
}
