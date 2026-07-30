import { useInfiniteQuery } from '@tanstack/react-query';
import { api, nextCursorPageParam } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface AuditEntry {
	id: string;
	project_id: string | null;
	actor_type: string;
	actor_member_id: string | null;
	actor_api_key_id: string | null;
	actor_name: string | null;
	project_slug: string | null;
	project_name: string | null;
	action: string;
	entity_type: string;
	entity_id: string | null;
	/** Identifier of the task when the row's entity is a task. */
	entity_identifier: string | null;
	/** Identifier of the task referenced via details.task_id (runs, assets, credentials). */
	ref_task_identifier: string | null;
	details: Record<string, unknown>;
	created_at: string;
}

type AuditFilters = { entity_type?: string; action?: string };

/**
 * The activity feed is keyset-paginated: it reads an append-only table that is
 * never pruned, so a `total` would cost a full-table count per page load to
 * render a number nobody acts on, and offsets would drift as rows land while
 * someone reads. Both hooks return the flattened entries plus the load-older
 * controls; the cursor is opaque and passed straight back.
 */
const PAGE_SIZE = '50';

export interface AuditLogFeed {
	entries: AuditEntry[] | undefined;
	hasMore: boolean;
	loadMore: () => void;
	isLoadingMore: boolean;
}

function flatten(query: ReturnType<typeof useInfiniteQuery<{ data: AuditEntry[] }>>): AuditLogFeed {
	return {
		entries: query.data?.pages.flatMap((page) => page.data),
		hasMore: Boolean(query.hasNextPage),
		loadMore: () => {
			void query.fetchNextPage();
		},
		isLoadingMore: query.isFetchingNextPage,
	};
}

// Per-project view — a filtered slice of the instance log scoped to one project.
export function useProjectAuditLog(projectId: string, filters?: AuditFilters): AuditLogFeed {
	const query = useInfiniteQuery({
		queryKey: queryKeys.projects.auditLog(projectId, filters),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			api.getCursorPaginated<AuditEntry>(`/api/projects/${projectId}/audit-log`, {
				entity_type: filters?.entity_type,
				action: filters?.action,
				limit: PAGE_SIZE,
				cursor: pageParam,
			}),
		getNextPageParam: nextCursorPageParam,
	});
	return flatten(query);
}

// Instance-level view — every project plus instance-scoped (project_id NULL) rows.
// Superuser only; the un-prefixed /api/audit-log route enforces it.
export function useInstanceAuditLog(filters?: AuditFilters): AuditLogFeed {
	const query = useInfiniteQuery({
		queryKey: queryKeys.instanceAuditLog(filters),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			api.getCursorPaginated<AuditEntry>('/api/audit-log', {
				entity_type: filters?.entity_type,
				action: filters?.action,
				limit: PAGE_SIZE,
				cursor: pageParam,
			}),
		getNextPageParam: nextCursorPageParam,
	});
	return flatten(query);
}
