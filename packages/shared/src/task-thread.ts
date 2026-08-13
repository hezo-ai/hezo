import { CommentContentType } from './types/common.js';

/**
 * How a task thread renders.
 *
 * `Conversation` shows what people said and what people can act on, folding the
 * machinery (completed runs, status changes, links) into expandable groups.
 * `Detailed` shows every row at full weight, in order.
 */
export const TaskView = {
	Conversation: 'conversation',
	Detailed: 'detailed',
} as const;
export type TaskView = (typeof TaskView)[keyof typeof TaskView];

/** Every view, in the order the settings and rail controls render them. */
export const TASK_VIEWS = [TaskView.Conversation, TaskView.Detailed] as const;

/** What an instance shows before an admin chooses otherwise. */
export const DEFAULT_TASK_VIEW: TaskView = TaskView.Conversation;

export function isTaskView(value: unknown): value is TaskView {
	return typeof value === 'string' && (TASK_VIEWS as readonly string[]).includes(value);
}

/**
 * Content types that render as a one-line event rather than an authored comment.
 * These are the only rows the fold rule can ever hide - everything else is
 * either something a person wrote or something a person must act on.
 */
export function isInlineEventType(contentType: string): boolean {
	return contentType === CommentContentType.System || contentType === CommentContentType.Run;
}

/** The minimum a row must expose for the fold rule to judge it. */
export interface ThreadRow {
	id: string;
	content_type: string;
	/** Structural payload. Run and system rows carry `run_id`; system rows carry `kind`. */
	content?: unknown;
}

/**
 * What the thread knows about the runs behind its rows. Both ids come from the
 * task, not from the rows - a row's own payload never says whether its run is
 * still going or whether it is the one offering a retry.
 */
export interface ThreadFoldContext {
	/** The run currently executing or queued on this task. */
	activeRunId?: string | null;
	/** The run eligible for a Retry button: latest failure, nothing active. */
	retryableRunId?: string | null;
}

function contentObject(row: ThreadRow): { run_id?: unknown; kind?: unknown } | null {
	return row.content && typeof row.content === 'object'
		? (row.content as { run_id?: unknown; kind?: unknown })
		: null;
}

/** The `run_id` a run or `run_failed` row points at, when it carries one. */
export function threadRowRunId(row: ThreadRow): string | null {
	const runId = contentObject(row)?.run_id;
	return typeof runId === 'string' ? runId : null;
}

/** A `system` row announcing that a run failed. Carries the failed run's id. */
export function isRunFailedRow(row: ThreadRow): boolean {
	return (
		row.content_type === CommentContentType.System && contentObject(row)?.kind === 'run_failed'
	);
}

/** A run row whose run is executing or queued right now. Renders as the working row. */
export function isWorkingThreadRow(row: ThreadRow, ctx: ThreadFoldContext): boolean {
	if (row.content_type !== CommentContentType.Run) return false;
	const runId = threadRowRunId(row);
	return runId !== null && runId === ctx.activeRunId;
}

/**
 * **The rule.** A row stays in the conversation if it is something a person
 * said, or something a person can act on. Everything else folds.
 *
 * The two run exceptions are not special cases bolted on - they are the rule
 * applied. A live run is the current state of the task, and the latest failure
 * carries a Retry button, so both are actionable.
 */
export function isFoldableThreadRow(row: ThreadRow, ctx: ThreadFoldContext = {}): boolean {
	if (!isInlineEventType(row.content_type)) return false;
	if (row.content_type === CommentContentType.Run) {
		const runId = threadRowRunId(row);
		if (runId !== null && (runId === ctx.activeRunId || runId === ctx.retryableRunId)) {
			return false;
		}
	}
	return true;
}

/**
 * What a collapsed group says about itself. `failedRuns` counts run rows a
 * sibling `run_failed` row in the same thread vouches for - a failure that
 * never wrote one is counted as a plain run rather than guessed at, so the
 * number is only ever an undercount, never a claim the thread cannot support.
 */
export interface ThreadGroupSummary {
	/** Rows inside the group. */
	total: number;
	failedRuns: number;
	/** Run rows not known to have failed. */
	runs: number;
	/** System rows, excluding the `run_failed` notices already counted as failures. */
	changes: number;
}

export type ThreadItem<T extends ThreadRow> =
	| { kind: 'row'; key: string; row: T }
	| { kind: 'group'; key: string; rows: T[]; summary: ThreadGroupSummary };

/** Run ids the thread positively knows failed, from its own `run_failed` rows. */
export function failedRunIds(rows: readonly ThreadRow[]): Set<string> {
	const ids = new Set<string>();
	for (const row of rows) {
		if (!isRunFailedRow(row)) continue;
		const runId = threadRowRunId(row);
		if (runId) ids.add(runId);
	}
	return ids;
}

function summarize(rows: readonly ThreadRow[], failed: ReadonlySet<string>): ThreadGroupSummary {
	let failedRuns = 0;
	let runs = 0;
	let changes = 0;
	for (const row of rows) {
		if (row.content_type === CommentContentType.Run) {
			const runId = threadRowRunId(row);
			if (runId && failed.has(runId)) failedRuns++;
			else runs++;
		} else if (isRunFailedRow(row)) {
			// Already represented by the run row it names; counting it again would
			// report one failure as two events' worth of trouble.
		} else {
			changes++;
		}
	}
	return { total: rows.length, failedRuns, runs, changes };
}

/**
 * Collapse a thread into the rows a reader sees. Foldable rows are grouped only
 * while they are **contiguous**, so a group sits in chronological position
 * between the comments it happened between. Nothing is reordered or dropped.
 *
 * In `Detailed` every row comes back as its own item, which is what makes the
 * two views one code path rather than two feeds.
 *
 * Keys are derived from row ids, so they survive a refetch: a group keyed on its
 * first row keeps its identity - and its expanded state - when later rows join it.
 */
export function buildThreadItems<T extends ThreadRow>(
	rows: readonly T[],
	view: TaskView,
	ctx: ThreadFoldContext = {},
): ThreadItem<T>[] {
	if (view === TaskView.Detailed) {
		return rows.map((row) => ({ kind: 'row', key: `row:${row.id}`, row }));
	}
	const failed = failedRunIds(rows);
	const items: ThreadItem<T>[] = [];
	let i = 0;
	while (i < rows.length) {
		if (!isFoldableThreadRow(rows[i], ctx)) {
			items.push({ kind: 'row', key: `row:${rows[i].id}`, row: rows[i] });
			i++;
			continue;
		}
		const start = i;
		while (i < rows.length && isFoldableThreadRow(rows[i], ctx)) i++;
		const group = rows.slice(start, i);
		items.push({
			kind: 'group',
			key: `group:${group[0].id}`,
			rows: group,
			summary: summarize(group, failed),
		});
	}
	return items;
}

/** The group holding a given row, or null when the row is not folded. */
export function findGroupKeyForRow<T extends ThreadRow>(
	items: readonly ThreadItem<T>[],
	rowId: string,
): string | null {
	for (const item of items) {
		if (item.kind !== 'group') continue;
		if (item.rows.some((r) => r.id === rowId)) return item.key;
	}
	return null;
}
