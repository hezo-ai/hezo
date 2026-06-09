import { WsMessageType, type WsRowChangeMessage, wsRoom } from '@hezo/shared';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSocket } from '../contexts/socket-context';
import { invalidateTeamAgentCaches } from '../lib/invalidate-team-caches';
import { queryKeys } from '../lib/query-keys';
import type { Project } from './use-projects';

/**
 * Query-key builders per row-change table. `cid` is the project slug the change
 * maps to — the row's own project for project-scoped tables, or the backing
 * team's user-facing project for team-wide tables. Project slug is the single
 * identifier across the query layer, so realtime invalidation keys by it too.
 */
const TABLE_TO_QUERY_KEY: Record<
	string,
	(cid: string, row: Record<string, unknown>) => QueryKey[]
> = {
	tasks: (cid) => [
		queryKeys.projects.tasks(cid),
		queryKeys.projects.all(),
		queryKeys.teams.all(),
		// Prefix of `tasksAll(slugs)` — invalidates every cross-project task index.
		['tasks', 'all'],
		queryKeys.projectIntakes(),
	],
	heartbeat_runs: (cid, row) => {
		const keys: QueryKey[] = [queryKeys.projects.tasks(cid)];
		// A run starting/finishing flips the task's run-now availability (task_busy),
		// so refresh that task's queued-wakeups (and their dispatch state).
		if (row.task_id) {
			keys.push(queryKeys.projects.taskQueuedWakeups(cid, row.task_id as string));
		}
		if (row.member_id) {
			keys.push(queryKeys.projects.agentHeartbeatRuns(cid, row.member_id as string));
			if (row.id) {
				keys.push(
					queryKeys.projects.agentHeartbeatRun(cid, row.member_id as string, row.id as string),
				);
			}
		}
		return keys;
	},
	agent_wakeup_requests: (cid, row) => {
		const keys: QueryKey[] = [queryKeys.projects.tasks(cid)];
		if (row.task_id) {
			keys.push(queryKeys.projects.taskQueuedWakeups(cid, row.task_id as string));
		}
		return keys;
	},
	task_comments: (cid) => [queryKeys.projects.tasks(cid)],
	comment_reactions: (cid) => [queryKeys.projects.tasks(cid)],
	comment_attachments: (cid) => [queryKeys.projects.tasks(cid)],
	member_agents: (cid) => [queryKeys.projects.agents(cid)],
	projects: () => [queryKeys.projects.all(), queryKeys.projectIntakes()],
	approvals: (cid) => [
		queryKeys.projects.approvals(cid),
		queryKeys.projects.inboxCount(cid),
		queryKeys.approvals.root(),
	],
	admin_mentions: (cid) => [
		queryKeys.projects.tasks(cid),
		queryKeys.projects.inboxMentions(cid),
		queryKeys.projects.inboxCount(cid),
		queryKeys.inboxMentions.root(),
	],
	documents: (cid, row) => {
		switch (row.type) {
			case 'project_doc':
				return [queryKeys.projects.docs(cid), queryKeys.projects.all()];
			case 'skill':
				return [queryKeys.projects.skills(cid)];
			case 'team_preferences':
				return [queryKeys.projects.preferences(cid)];
			default:
				return [];
		}
	},
	secrets: (cid) => [queryKeys.projects.secrets(cid)],
	mcp_connections: (cid, row) => {
		const keys: QueryKey[] = [queryKeys.projects.mcpConnections(cid)];
		if (row.id) {
			keys.push(queryKeys.projects.mcpConnectionDetail(cid, row.id as string));
		}
		return keys;
	},
	api_keys: (cid) => [queryKeys.projects.apiKeys(cid)],
	cost_entries: (cid) => [['projects', cid, 'costs']],
	execution_locks: (cid) => [['projects', cid, 'execution-locks']],
	repos: (cid) => [queryKeys.projects.repos(cid), queryKeys.projects.all()],
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
			const index = queryClient.getQueryData<Project[]>(queryKeys.projects.all()) ?? [];
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
				queryClient.invalidateQueries({ queryKey: queryKeys.approvals.root() });
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
