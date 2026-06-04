import { AuthType, TaskStatus } from '@hezo/shared';
import type { AuthInfo } from './types';

/**
 * A run is opened on exactly one ticket (`heartbeat_runs.task_id`, surfaced on
 * `AuthInfo` as `auth.taskId`). An agent may freely update *other* tickets'
 * fields within a run — folding an @-mention into its own existing ticket's
 * description/progress_summary/rules, declaring blockers, creating sub-tasks —
 * and may set its OWN run-ticket to `in_progress` (e.g. the QA Engineer hands a
 * ticket back to the Engineer by setting the ticket-under-review, which IS the
 * run's task, back to `in_progress`). What it must NOT do is *start a different
 * ticket* inside this run: flip some other ticket to `in_progress` and begin
 * executing it. That ticket gets its own run, with its own dependency /
 * capacity / busy checks in the wakeup dispatcher — doing it here misattributes
 * the work/cost to the current ticket and lets a concurrent run double up.
 *
 * `targetTaskId` MUST be the resolved task UUID — callers normalize identifiers
 * like "TO-8" to a UUID first (the MCP `tool()` wrapper and the REST route's
 * `resolveTaskId` both do this), and `auth.taskId` is always a UUID.
 *
 * Returns an error message to reject with, or `null` to allow. Board / API-key
 * callers and runs not bound to a task (null `task_id`, e.g. idle heartbeats)
 * pass through.
 */
export function assertRunTaskScope(
	auth: AuthInfo,
	targetTaskId: string,
	nextStatus: string | undefined,
): string | null {
	if (auth.type !== AuthType.Agent) return null;
	if (nextStatus !== TaskStatus.InProgress) return null;
	if (!auth.taskId) return null;
	if (auth.taskId === targetTaskId) return null;
	return 'This run is scoped to its own ticket — you cannot move a different ticket to "in_progress" here. Leave it for its own run (the next heartbeat or assignment picks it up), or hand off via a comment/@mention or a sub-task (create_task with parent_task_id).';
}
