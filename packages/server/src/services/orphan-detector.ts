import type { PGlite } from '@electric-sql/pglite';
import {
	AgentRuntimeStatus,
	ApprovalType,
	HeartbeatRunStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const MAX_RETRIES = 3;
const SAFETY_WINDOW_SECONDS = 30;

export async function detectOrphans(
	db: PGlite,
	liveRunIds: Set<string>,
	wsManager?: WebSocketManager,
): Promise<number> {
	const orphans = await db.query<{
		id: string;
		member_id: string;
		company_id: string;
		issue_id: string | null;
		process_loss_retry_count: number;
	}>(
		`SELECT id, member_id, company_id, issue_id, process_loss_retry_count
		 FROM heartbeat_runs
		 WHERE status = $1::heartbeat_run_status
		   AND started_at < now() - ($2 || ' seconds')::interval`,
		[HeartbeatRunStatus.Running, String(SAFETY_WINDOW_SECONDS)],
	);

	let orphanCount = 0;

	for (const run of orphans.rows) {
		if (liveRunIds.has(run.id)) continue;

		orphanCount++;

		await db.query(
			`UPDATE heartbeat_runs
			 SET status = $2::heartbeat_run_status,
			     finished_at = now(),
			     error = 'Orphaned: process no longer running',
			     process_loss_retry_count = process_loss_retry_count + 1
			 WHERE id = $1`,
			[run.id, HeartbeatRunStatus.Failed],
		);

		await db.query(
			'UPDATE execution_locks SET released_at = now() WHERE member_id = $1 AND released_at IS NULL',
			[run.member_id],
		);

		const remaining = await db.query<{ id: string }>(
			`SELECT id FROM heartbeat_runs
			 WHERE member_id = $1 AND status = $2::heartbeat_run_status AND id != $3
			 LIMIT 1`,
			[run.member_id, HeartbeatRunStatus.Running, run.id],
		);

		if (remaining.rows.length === 0) {
			const reset = await db.query<{ id: string }>(
				`UPDATE member_agents
				 SET runtime_status = $1::agent_runtime_status
				 WHERE id = $2 AND runtime_status = $3::agent_runtime_status
				 RETURNING id`,
				[AgentRuntimeStatus.Idle, run.member_id, AgentRuntimeStatus.Active],
			);
			if (reset.rows.length > 0) {
				broadcastRowChange(wsManager, wsRoom.company(run.company_id), 'member_agents', 'UPDATE', {
					id: run.member_id,
					runtime_status: AgentRuntimeStatus.Idle,
				});
			}
		}

		broadcastRowChange(wsManager, wsRoom.company(run.company_id), 'heartbeat_runs', 'UPDATE', {
			id: run.id,
			member_id: run.member_id,
			issue_id: run.issue_id,
			status: HeartbeatRunStatus.Failed,
			error: 'Orphaned: process no longer running',
		});

		if (run.process_loss_retry_count + 1 < MAX_RETRIES) {
			const failedRun = await db.query<{
				exit_code: number | null;
				log_text: string | null;
			}>('SELECT exit_code, log_text FROM heartbeat_runs WHERE id = $1', [run.id]);
			const fr = failedRun.rows[0];

			await createWakeup(db, run.member_id, run.company_id, WakeupSource.Timer, {
				reason: 'orphan_retry',
				retry_count: run.process_loss_retry_count + 1,
				max_retries: MAX_RETRIES,
				previous_failure: {
					run_id: run.id,
					exit_code: fr?.exit_code ?? null,
					log_tail: fr?.log_text?.slice(-1000) ?? null,
				},
			});
		} else {
			await db.query(
				`INSERT INTO approvals (company_id, type, payload)
				 VALUES ($1, $2::approval_type, $3::jsonb)`,
				[
					run.company_id,
					ApprovalType.Strategy,
					JSON.stringify({
						type: 'agent_error',
						member_id: run.member_id,
						message: `Agent has failed ${MAX_RETRIES} consecutive times. Manual intervention required.`,
					}),
				],
			);
		}
	}

	return orphanCount;
}
