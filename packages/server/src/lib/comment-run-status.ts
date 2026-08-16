import { CommentContentType, type HeartbeatRunStatus } from '@hezo/shared';
import type { Db } from '../db/database';

/** Cheap shape guard before a value reaches a `::uuid` cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRunRow = (row: Record<string, unknown>): boolean =>
	row.content_type === CommentContentType.Run;

/** The run this row points at, or null when it names none we could look up. */
function runIdOf(row: Record<string, unknown>): string | null {
	const content = row.content;
	if (!content || typeof content !== 'object') return null;
	const runId = (content as { run_id?: unknown }).run_id;
	return typeof runId === 'string' && UUID_RE.test(runId) ? runId : null;
}

/**
 * Annotate every `run` comment with its run's real outcome, as `run_status`.
 *
 * A run comment is written when the run starts and never updated, so its stored
 * `content` cannot say how the run ended. Without this, a reader summarizing a
 * thread has only the `run_failed` notices to go on - and those stop being
 * written after a streak of failures, so a task that has failed hundreds of
 * times reports two failures and a crowd of apparently healthy runs.
 *
 * One extra query per thread, skipped entirely when there are no run rows. The
 * alternative - joining through `content->>'run_id'` - has to cast that JSON
 * text to `uuid`, which throws on a malformed value and would fail the whole
 * thread rather than the one row. `task_id` is pinned so a row can never
 * surface a run belonging to another task.
 */
export async function attachRunStatuses(
	db: Db,
	taskId: string,
	rows: Record<string, unknown>[],
): Promise<void> {
	const runRows = rows.filter(isRunRow);
	if (runRows.length === 0) return;

	const runIds = [...new Set(runRows.map(runIdOf).filter((id): id is string => id !== null))];
	const statusById = new Map<string, HeartbeatRunStatus>();
	if (runIds.length > 0) {
		const result = await db.query<{ id: string; status: HeartbeatRunStatus }>(
			`SELECT id, status FROM heartbeat_runs WHERE id = ANY($1::uuid[]) AND task_id = $2`,
			[runIds, taskId],
		);
		for (const r of result.rows) statusById.set(r.id, r.status);
	}

	// Every run row gets the key, null when the run could not be resolved - a
	// reader distinguishes "no status" from "not a run row", and falls back to
	// the `run_failed` notices for the former.
	for (const row of runRows) {
		const runId = runIdOf(row);
		row.run_status = (runId === null ? undefined : statusById.get(runId)) ?? null;
	}
}
