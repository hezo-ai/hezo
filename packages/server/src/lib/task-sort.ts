import { CommentContentType, TaskPriority, TERMINAL_TASK_STATUSES } from '@hezo/shared';

const TASK_ALIAS = 'i';

export const TASK_LIST_SORT_FIELDS = [
	'work_order',
	'created_at',
	'updated_at',
	'priority',
	'number',
] as const;
export type TaskListSortField = (typeof TASK_LIST_SORT_FIELDS)[number];

export function taskActiveRunExistsSql(alias = TASK_ALIAS): string {
	return `EXISTS (
    SELECT 1 FROM heartbeat_runs hr
    WHERE hr.task_id = ${alias}.id AND hr.status IN ('running', 'queued')
  )`;
}

/**
 * The comment kinds that park a task on a human until they answer, identified by
 * `chosen_option IS NULL`. `connect_required` is deliberately absent: it never
 * sets `chosen_option` (a connector's resolved state lives on its `oauth_status`),
 * so it would read as unanswered forever.
 */
const PENDING_ASK_CONTENT_TYPES = [
	CommentContentType.Action,
	CommentContentType.CredentialRequest,
	CommentContentType.AssetDeletionRequest,
] as const;

// Spelled as literals rather than placeholders so the predicate matches migration
// 059's partial-index WHERE clause verbatim - a parameterized IN list leaves the
// planner unable to prove the implication under a generic plan, and the index goes
// unused. The values come from a frozen enum, never from a request.
const PENDING_ASK_CONTENT_TYPE_LIST = PENDING_ASK_CONTENT_TYPES.map(
	(kind) => `'${kind}'::comment_content_type`,
).join(', ');

/**
 * EXISTS for an unread admin-inbox row on the task, scoped to one admin user.
 * `adminUserIdx` is the placeholder holding that user's id; a non-admin caller
 * passes NULL there and the predicate matches nothing.
 */
export function adminUnreadMentionExistsSql(alias: string, adminUserIdx: number): string {
	return `EXISTS (
    SELECT 1 FROM admin_mentions bm
    WHERE bm.task_id = ${alias}.id AND bm.user_id = $${adminUserIdx}
      AND bm.read_at IS NULL AND bm.archived_at IS NULL
  )`;
}

/**
 * "This one comment is an ask still standing on a human" - it raised an admin-inbox
 * row, or it is a choice card nobody has answered (`chosen_option IS NULL`).
 *
 * Comment-scoped, where {@link adminActionPendingSql} is task-scoped: the dispatch
 * suppression needs to know *which* comment carries the ask, so it can weigh that
 * comment's place in the thread against the newest reply. Both spell the content
 * types through `PENDING_ASK_CONTENT_TYPE_LIST` so migration 059's partial index
 * applies to either caller.
 *
 * The inbox leg is deliberately not scoped to `read_at IS NULL`: an admin reading
 * the notification is not an admin answering it, and a suppression keyed on the
 * badge would lift while the question still stands.
 */
export function outstandingAdminAskExistsSql(commentAlias: string): string {
	return `(
    EXISTS (SELECT 1 FROM admin_mentions am WHERE am.comment_id = ${commentAlias}.id)
    OR (${commentAlias}.chosen_option IS NULL
        AND ${commentAlias}.content_type IN (${PENDING_ASK_CONTENT_TYPE_LIST}))
  )`;
}

/**
 * "This task is waiting on the admin" - the task list's second ordering tier, and
 * a column on its rows. Two legs: an unread inbox row for the viewing admin (an
 * `@admin` ask, a credential request, an asset-deletion ask), or an ask comment
 * nobody has answered yet (the hire, goal and repo-setup choice cards, which park
 * a task on a human without raising an inbox row at all).
 *
 * Only the first leg is per-user, so a non-admin caller sees this driven by
 * unanswered asks alone - the same way `has_unread_admin_mention` already reads
 * false for them.
 */
export function adminActionPendingSql(alias: string, adminUserIdx: number): string {
	return `(
    ${adminUnreadMentionExistsSql(alias, adminUserIdx)}
    OR EXISTS (
      SELECT 1 FROM task_comments ask
      WHERE ask.task_id = ${alias}.id
        AND ask.chosen_option IS NULL
        AND ask.content_type IN (${PENDING_ASK_CONTENT_TYPE_LIST})
    )
  )`;
}

/** Parameterized EXISTS for open dependency blockers (non-terminal upstream tasks). */
export function appendOpenBlockerExistsSql(
	alias: string,
	paramStart: number,
	params: unknown[],
): string {
	const termList = TERMINAL_TASK_STATUSES.map((_, i) => `$${paramStart + i}::task_status`).join(
		', ',
	);
	params.push(...TERMINAL_TASK_STATUSES);
	return `EXISTS (
    SELECT 1 FROM task_dependencies d
    JOIN tasks b ON b.id = d.blocked_by_task_id
    WHERE d.task_id = ${alias}.id
      AND b.status NOT IN (${termList})
  )`;
}

/** Priority rank matching JobManager task selection (urgent first). */
export function appendPriorityOrderSql(
	alias: string,
	paramStart: number,
	params: unknown[],
): string {
	const priorities = [
		TaskPriority.Urgent,
		TaskPriority.High,
		TaskPriority.Medium,
		TaskPriority.Low,
	];
	const cases = priorities
		.map((_, i) => `WHEN $${paramStart + i}::task_priority THEN ${i}`)
		.join(' ');
	params.push(...priorities);
	return `CASE ${alias}.priority ${cases} END`;
}

export function parseTaskListSort(sortParam: string | undefined): {
	field: TaskListSortField;
	direction: 'ASC' | 'DESC';
} {
	const raw = sortParam ?? 'work_order:asc';
	const [field, dir] = raw.split(':');
	const direction = dir === 'asc' ? 'ASC' : 'DESC';
	if ((TASK_LIST_SORT_FIELDS as readonly string[]).includes(field)) {
		return { field: field as TaskListSortField, direction };
	}
	return { field: 'work_order', direction: 'ASC' };
}

/**
 * Build ORDER BY for the task list. Every sort mode is tiered first: tasks with a
 * run in flight or queued, then tasks waiting on the admin, then the rest. The
 * chosen field only orders within a tier.
 * `work_order`: ready → priority → ticket number (matches agent dispatch).
 *
 * `adminActionPending` is the expression from {@link adminActionPendingSql}, passed
 * in rather than built here so the caller can project the same tier as a column
 * without pushing its params twice.
 */
export function buildTaskListOrderBy(
	field: TaskListSortField,
	direction: 'ASC' | 'DESC',
	params: unknown[],
	idx: number,
	adminActionPending: string,
): { sql: string; nextIdx: number } {
	const tiers = `${taskActiveRunExistsSql()} DESC, ${adminActionPending} DESC`;
	if (field === 'work_order') {
		const blockerStart = idx;
		const blockerSql = appendOpenBlockerExistsSql(TASK_ALIAS, blockerStart, params);
		idx += TERMINAL_TASK_STATUSES.length;
		const priorityStart = idx;
		const prioritySql = appendPriorityOrderSql(TASK_ALIAS, priorityStart, params);
		idx += 4;
		return {
			sql: `${tiers}, ${blockerSql} ASC, ${prioritySql} ASC, ${TASK_ALIAS}.number ASC`,
			nextIdx: idx,
		};
	}
	return {
		sql: `${tiers}, ${TASK_ALIAS}.${field} ${direction}`,
		nextIdx: idx,
	};
}

/**
 * Build a relevance-rank expression for a task search term, meant to be prepended
 * to the task-list ORDER BY so the best identifier match floats to the top.
 *
 * The `search` filter matches the term as a substring of title, description OR
 * identifier, but the sort field (recency / work order) is otherwise blind to
 * *which* column matched — so a task that merely mentions the term in its body can
 * outrank the task whose identifier/number *is* the term (searching "169" leaving
 * HM-169 buried under HM-167). This tier makes the identifier win.
 *
 * Lower rank sorts first (ASC):
 *   0 — the term is the whole identifier (`HM-169` / `hm-169`)
 *   1 — the term is the task number (`169` → HM-169)
 *   2 — the identifier contains the term (`16` → HM-169)
 *   3 — the title contains the term
 *   4 — matched on description only
 *
 * Pushes two params (the raw term, then its `%term%` ILIKE pattern) and returns
 * the CASE expression plus the next free placeholder index.
 */
export function buildSearchRelevanceOrderSql(
	search: string,
	params: unknown[],
	idx: number,
): { sql: string; nextIdx: number } {
	const exactIdx = idx;
	params.push(search);
	const likeIdx = idx + 1;
	params.push(`%${search}%`);
	const sql = `CASE
      WHEN LOWER(${TASK_ALIAS}.identifier) = LOWER($${exactIdx}) THEN 0
      WHEN ${TASK_ALIAS}.number::text = $${exactIdx} THEN 1
      WHEN ${TASK_ALIAS}.identifier ILIKE $${likeIdx} THEN 2
      WHEN ${TASK_ALIAS}.title ILIKE $${likeIdx} THEN 3
      ELSE 4 END`;
	return { sql, nextIdx: idx + 2 };
}
