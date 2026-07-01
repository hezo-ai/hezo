import { WsMessageType, type WsRowChangeMessage, wsRoom } from '@hezo/shared';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
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
		queryKeys.projects.tasksProgressSummary(cid),
		queryKeys.projects.all(),
		queryKeys.projectIntakes(),
	],
	heartbeat_runs: (cid, row) => {
		const keys: QueryKey[] = [
			queryKeys.projects.tasks(cid),
			queryKeys.projects.tasksProgressSummary(cid),
		];
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
		// A progress-update run (a heartbeat run with no task) updates the Goals page's
		// runs footer; refresh it live.
		if (!row.task_id) {
			keys.push(queryKeys.projects.goalRuns(cid));
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
	projects: (cid) => [
		queryKeys.projects.all(),
		queryKeys.projectIntakes(),
		// The Captain refreshing the progress summary broadcasts a projects UPDATE.
		queryKeys.projects.progress(cid),
		queryKeys.projects.detail(cid),
	],
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
	cost_entries: (cid) => [['projects', cid, 'costs']],
	execution_locks: (cid) => [['projects', cid, 'execution-locks']],
	repos: (cid) => [queryKeys.projects.repos(cid), queryKeys.projects.all()],
	// `goals(cid)` = ['projects', slug, 'goals'] is a prefix of goalsFiltered /
	// goal / goalHistory / goalRuns, so it invalidates every goal query at once.
	goals: (cid) => [queryKeys.projects.goals(cid), queryKeys.projects.all()],
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
		// The project-index key (`['projects']`) is the exact key of the project
		// list query, but it is also a prefix of every project-scoped query
		// (`['projects', <slug>, ...]`). React Query invalidation is prefix-match by
		// default, so a fuzzy invalidation here would refetch EVERY project's task
		// list, comments, etc. on any single project's change — a cross-project
		// refetch storm. The mappers include it only to refresh the index (task
		// counts in the rail), so invalidate it exactly.
		const exact = isProjectIndexKey(key);
		queryClient.invalidateQueries({ queryKey: key, exact });
	}
}

/** True for the project-index key `['projects']` (see invalidate exact-match note). */
function isProjectIndexKey(key: QueryKey): boolean {
	return Array.isArray(key) && key.length === 1 && key[0] === 'projects';
}

/**
 * Resolve the project slug a row_change maps to, from the cached projects index.
 *
 * Prefers `row.project_id` — it resolves for *every* project, including the
 * `is_internal` HQ project. Falls back to `row.team_id`, which maps a team-wide
 * row to that team's user-facing (non-internal) project; that fallback can't
 * resolve HQ. Comment-family rows (`task_comments` / `comment_reactions` /
 * `comment_attachments`) have no `team_id` column, so they depend on the server
 * setting `project_id` on the broadcast (see `broadcastCommentFamilyChange`).
 */
export function resolveProjectSlugForRow(
	index: Project[],
	row: Record<string, unknown>,
): string | undefined {
	const teamUuid = row.team_id as string | undefined;
	const projectUuid = row.project_id as string | undefined;
	const byProjectId = projectUuid ? index.find((p) => p.id === projectUuid) : undefined;
	const teamUserProject = teamUuid
		? index.find((p) => p.team_id === teamUuid && !p.is_internal)
		: undefined;
	return byProjectId?.slug ?? teamUserProject?.slug;
}

/**
 * Strict project resolution: map a row to its project by `project_id` alone,
 * with no `team_id` fallback. Used for high-frequency, inherently project-scoped
 * tables ([[PROJECT_STRICT_TABLES]]) where the team fallback would misattribute
 * one project's activity to another and thrash its caches.
 */
export function resolveProjectSlugByIdOnly(
	index: Project[],
	row: Record<string, unknown>,
): string | undefined {
	const projectUuid = row.project_id as string | undefined;
	return projectUuid ? index.find((p) => p.id === projectUuid)?.slug : undefined;
}

/**
 * Tables whose row-change broadcasts must resolve to their own project by
 * `project_id` only (never the team fallback). These fire often during agent
 * activity, so a misattributed invalidation storms an unrelated project's
 * queries. Their broadcasts carry `project_id`; a row without one is skipped.
 */
const PROJECT_STRICT_TABLES = new Set([
	'tasks',
	'task_comments',
	'heartbeat_runs',
	'agent_wakeup_requests',
]);

interface TeamRoom {
	id: string;
	slug: string;
}

/**
 * Refetch everything after a WebSocket drop heals. Row-change events emitted
 * while the socket was down (e.g. a dev-server restart kicking off container
 * rebuilds at boot) are lost — there is no replay — so the only way to catch
 * up is a full invalidation once the connection is back. The initial connect
 * is skipped: queries are freshly fetched on mount anyway.
 */
export function useInvalidateOnReconnect(connected: boolean): void {
	const queryClient = useQueryClient();
	const hadConnected = useRef(false);

	useEffect(() => {
		if (!connected) return;
		if (hadConnected.current) {
			queryClient.invalidateQueries();
		}
		hadConnected.current = true;
	}, [connected, queryClient]);
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
	const { connected, joinRoom, leaveRoom, subscribe } = useSocket();

	useInvalidateOnReconnect(connected);

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

			// Resolve the project slug the change maps to from the cached index.
			const index = queryClient.getQueryData<Project[]>(queryKeys.projects.all()) ?? [];
			// High-frequency, project-scoped tables must resolve by their own
			// `project_id` only — never the `team_id` fallback. That fallback maps a
			// row to the team's first non-internal project, so a run/wakeup in *any*
			// project on the team would invalidate *every* team project's task list,
			// producing a refetch storm (and breaking infinite-scroll pagination,
			// which never settles while it's being re-fetched). Skip when the row
			// carries no resolvable project.
			const cid = PROJECT_STRICT_TABLES.has(table)
				? resolveProjectSlugByIdOnly(index, row)
				: resolveProjectSlugForRow(index, row);

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

	// The global project-index room is independent of team membership: a freshly
	// created project lands in a team whose room this client hasn't joined (and
	// whose row isn't in the cached index yet to resolve a slug from), so the
	// team-scoped path above can't surface it. Subscribe here unconditionally so
	// the index — and with it the project rail — refetches the instant any
	// project is created, whether by the dialog, the CEO, or another session.
	useEffect(() => {
		const room = wsRoom.projects();
		joinRoom(room);
		const unsubscribe = subscribe(WsMessageType.ProjectsChanged, () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(), exact: true });
			queryClient.invalidateQueries({ queryKey: queryKeys.projectIntakes() });
		});
		return () => {
			unsubscribe();
			leaveRoom(room);
		};
	}, [queryClient, joinRoom, leaveRoom, subscribe]);
}
