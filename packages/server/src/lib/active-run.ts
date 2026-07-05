import { HeartbeatRunStatus } from '@hezo/shared';
import type { Db } from '../db/database';

export type ActiveRunCheck = { ok: true } | { ok: false; message: string };

export const ACTIVE_RUN_REASSIGN_ERROR =
	'Cannot change assignee while an agent is running on this task';

export async function assertNoActiveRun(db: Db, taskId: string): Promise<ActiveRunCheck> {
	const r = await db.query<{ has_active_run: boolean }>(
		`SELECT EXISTS (
            SELECT 1 FROM heartbeat_runs
            WHERE task_id = $1 AND status IN ($2, $3)
         ) AS has_active_run`,
		[taskId, HeartbeatRunStatus.Running, HeartbeatRunStatus.Queued],
	);
	if (r.rows[0]?.has_active_run) {
		return { ok: false, message: ACTIVE_RUN_REASSIGN_ERROR };
	}
	return { ok: true };
}
