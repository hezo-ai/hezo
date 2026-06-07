import { WsMessageType, type WsRowChangeMessage, wsRoom } from '@hezo/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSocket } from '../contexts/socket-context';
import { invalidateTeamAgentCaches } from '../lib/invalidate-team-caches';
import type { Project } from './use-projects';

/**
 * Query-key builders per row-change table. `cid` is the project slug the change
 * maps to — the row's own project for project-scoped tables, or the backing
 * team's user-facing project for team-wide tables. Project slug is the single
 * identifier across the query layer, so realtime invalidation keys by it too.
 */
const TABLE_TO_QUERY_KEY: Record<
	string,
	(cid: string, row: Record<string, unknown>) => string[][]
> = {
	tasks: (cid) => [
		['projects', cid, 'tasks'],
		['projects'],
		['teams'],
		['tasks', 'all'],
		['project-intakes'],
	],
	heartbeat_runs: (cid, row) => {
		const keys: string[][] = [['projects', cid, 'tasks']];
		// A run starting/finishing flips the task's run-now availability (task_busy),
		// so refresh that task's queued-wakeups (and their dispatch state).
		if (row.task_id) {
			keys.push(['projects', cid, 'tasks', row.task_id as string, 'queued-wakeups']);
		}
		if (row.member_id) {
			keys.push(['projects', cid, 'agents', row.member_id as string, 'heartbeat-runs']);
			if (row.id) {
				keys.push([
					'projects',
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
		const keys: string[][] = [['projects', cid, 'tasks']];
		if (row.task_id) {
			keys.push(['projects', cid, 'tasks', row.task_id as string, 'queued-wakeups']);
		}
		return keys;
	},
	task_comments: (cid) => [['projects', cid, 'tasks']],
	comment_reactions: (cid) => [['projects', cid, 'tasks']],
	comment_attachments: (cid) => [['projects', cid, 'tasks']],
	member_agents: (cid) => [['projects', cid, 'agents']],
	projects: (cid) => [['projects'], ['project-intakes']],
	approvals: (cid) => [
		['projects', cid, 'approvals'],
		['projects', cid, 'inbox-count'],
		['approvals'],
	],
	admin_mentions: (cid) => [
		['projects', cid, 'tasks'],
		['projects', cid, 'inbox-mentions'],
		['projects', cid, 'inbox-count'],
		['inbox-mentions'],
	],
	documents: (cid, row) => {
		switch (row.type) {
			case 'project_doc':
				return [['projects', cid, 'docs'], ['projects']];
			case 'skill':
				return [['projects', cid, 'skills']];
			case 'team_preferences':
				return [['projects', cid, 'preferences']];
			default:
				return [];
		}
	},
	secrets: (cid) => [['projects', cid, 'secrets']],
	mcp_connections: (cid, row) => {
		const keys: string[][] = [['projects', cid, 'mcp-connections']];
		if (row.id) {
			keys.push(['projects', cid, 'mcp-connections', 'detail', row.id as string]);
		}
		return keys;
	},
	api_keys: (cid) => [['projects', cid, 'api-keys']],
	cost_entries: (cid) => [['projects', cid, 'costs']],
	execution_locks: (cid) => [['projects', cid, 'execution-locks']],
	repos: (cid) => [['projects', cid, 'repos'], ['projects']],
};

/** Invalidate TanStack Query caches for a realtime row_change event. */
export function invalidateQueriesForRowChange(
	queryClient: QueryClient,
	projectSlug: string,
	table: string,
	row: Record<string, unknown>,
): void {
	const keyMapper = TABLE_TO_QUERY_KEY[table];
	if (!keyMapper) return;
	for (const key of keyMapper(projectSlug, row)) {
		queryClient.invalidateQueries({ queryKey: key });
	}
}

interface TeamRoom {
	id: string;
	slug: string;
}

/**
 * Subscribe to all team rooms so global UI (inbox badge, home) updates without a
 * full page refresh. Row-change events carry team/project UUIDs; we translate
 * them to the relevant project slug (the row's own project, or the team's
 * user-facing project for team-wide rows) before invalidating project-keyed
 * caches.
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

		const rooms = teams.map((t) => wsRoom.team(t.id));
		for (const room of rooms) {
			joinRoom(room);
		}

		const unsubscribe = subscribe(WsMessageType.RowChange, (msg) => {
			const { table, row } = msg as WsRowChangeMessage;
			const teamUuid = row.team_id as string | undefined;
			const projectUuid = row.project_id as string | undefined;

			// Resolve the project slug the change maps to from the cached index.
			const index = queryClient.getQueryData<Project[]>(['projects']) ?? [];
			const byProjectId = projectUuid ? index.find((p) => p.id === projectUuid) : undefined;
			const teamUserProject = teamUuid
				? index.find((p) => p.team_id === teamUuid && !p.is_internal)
				: undefined;
			const cid = byProjectId?.slug ?? teamUserProject?.slug;

			if (cid) {
				invalidateQueriesForRowChange(queryClient, cid, table, row);
				if (table === 'member_agents') {
					invalidateTeamAgentCaches(queryClient, cid);
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
