import { WsMessageType, type WsRowChangeMessage, wsRoom } from '@hezo/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSocket } from '../contexts/socket-context';
import { invalidateTeamAgentCaches } from '../lib/invalidate-team-caches';

const TABLE_TO_QUERY_KEY: Record<
	string,
	(teamSlug: string, row: Record<string, unknown>) => string[][]
> = {
	tasks: (cid) => [
		['teams', cid, 'tasks'],
		['teams', cid],
		['teams'],
		['teams', cid, 'projects'],
		['teams', cid, 'onboarding-intake'],
		['teams', cid, 'onboarding'],
	],
	heartbeat_runs: (cid, row) => {
		const keys: string[][] = [['teams', cid, 'tasks']];
		// A run starting/finishing flips the task's run-now availability (task_busy),
		// so refresh that task's queued-wakeups (and their dispatch state).
		if (row.task_id) {
			keys.push(['teams', cid, 'tasks', row.task_id as string, 'queued-wakeups']);
		}
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
	agent_wakeup_requests: (cid, row) => {
		const keys: string[][] = [['teams', cid, 'tasks']];
		if (row.task_id) {
			keys.push(['teams', cid, 'tasks', row.task_id as string, 'queued-wakeups']);
		}
		return keys;
	},
	task_comments: (cid) => [['teams', cid, 'tasks']],
	comment_reactions: (cid) => [['teams', cid, 'tasks']],
	comment_attachments: (cid) => [['teams', cid, 'tasks']],
	member_agents: (cid) => [['teams', cid, 'agents']],
	projects: (cid) => [
		['teams', cid, 'projects'],
		['teams', cid, 'onboarding'],
	],
	approvals: (cid) => [['teams', cid, 'approvals'], ['teams', cid, 'inbox-count'], ['approvals']],
	board_mentions: (cid) => [
		['teams', cid, 'inbox-mentions'],
		['teams', cid, 'inbox-count'],
		['inbox-mentions'],
	],
	documents: (cid, row) => {
		switch (row.type) {
			case 'project_doc':
				return [['teams', cid, 'projects']];
			case 'skill':
				return [['teams', cid, 'skills']];
			case 'team_preferences':
				return [['teams', cid, 'preferences']];
			default:
				return [];
		}
	},
	secrets: (cid) => [['teams', cid, 'secrets']],
	mcp_connections: (cid, row) => {
		const keys: string[][] = [['teams', cid, 'mcp-connections']];
		if (row.id) {
			keys.push(['teams', cid, 'mcp-connections', 'detail', row.id as string]);
		}
		return keys;
	},
	api_keys: (cid) => [['teams', cid, 'api-keys']],
	cost_entries: (cid) => [['teams', cid, 'costs']],
	execution_locks: (cid) => [['teams', cid, 'execution-locks']],
	repos: (cid) => [['teams', cid, 'projects']],
	goals: (cid) => [
		['teams', cid, 'goals'],
		['teams', cid, 'onboarding'],
	],
};

/** Invalidate TanStack Query caches for a realtime row_change event. */
export function invalidateQueriesForRowChange(
	queryClient: QueryClient,
	teamSlug: string,
	table: string,
	row: Record<string, unknown>,
): void {
	const keyMapper = TABLE_TO_QUERY_KEY[table];
	if (!keyMapper) return;
	for (const key of keyMapper(teamSlug, row)) {
		queryClient.invalidateQueries({ queryKey: key });
	}
}

interface TeamRoom {
	id: string;
	slug: string;
}

/**
 * Subscribe to all team rooms so global UI (inbox badge, home) updates without a full page refresh.
 */
export function useShellWebSockets(teams: TeamRoom[] | undefined): void {
	const queryClient = useQueryClient();
	const { joinRoom, leaveRoom, subscribe } = useSocket();

	const teamsKey =
		teams
			?.map((t) => `${t.id}:${t.slug}`)
			.sort()
			.join(',') ?? '';

	// biome-ignore lint/correctness/useExhaustiveDependencies: teamsKey tracks membership; teams read from latest render
	useEffect(() => {
		if (!teams?.length) return;

		const slugById = new Map(teams.map((t) => [t.id, t.slug]));
		const rooms = teams.map((t) => wsRoom.team(t.id));
		for (const room of rooms) {
			joinRoom(room);
		}

		const unsubscribe = subscribe(WsMessageType.RowChange, (msg) => {
			const { table, row } = msg as WsRowChangeMessage;
			const teamUuid = row.team_id as string | undefined;
			const teamSlug = teamUuid ? slugById.get(teamUuid) : undefined;
			if (teamSlug) {
				invalidateQueriesForRowChange(queryClient, teamSlug, table, row);
				if (table === 'member_agents') {
					invalidateTeamAgentCaches(queryClient, teamSlug);
				}
			}
			if (table === 'approvals') {
				queryClient.invalidateQueries({ queryKey: ['approvals'] });
			}
		});

		return () => {
			unsubscribe();
			for (const room of rooms) {
				leaveRoom(room);
			}
		};
	}, [teamsKey, queryClient, joinRoom, leaveRoom, subscribe]);
}

export function useWebSocket(wsTeamId: string | undefined, routeTeamId: string): void {
	const queryClient = useQueryClient();
	const { joinRoom, leaveRoom, subscribe } = useSocket();

	useEffect(() => {
		if (!wsTeamId) return;
		const room = wsRoom.team(wsTeamId);
		joinRoom(room);

		const unsubscribe = subscribe(WsMessageType.RowChange, (msg) => {
			const { table, row } = msg as WsRowChangeMessage;
			invalidateQueriesForRowChange(queryClient, routeTeamId, table, row);
			if (table === 'member_agents') {
				invalidateTeamAgentCaches(queryClient, routeTeamId);
			}
		});

		return () => {
			unsubscribe();
			leaveRoom(room);
		};
	}, [wsTeamId, routeTeamId, queryClient, joinRoom, leaveRoom, subscribe]);
}
