import type { PGlite } from '@electric-sql/pglite';
import { ApprovalType, HeartbeatRunStatus, WakeupSource } from '@hezo/shared';
import { createWakeup } from './wakeup';

const MAX_RETRIES = 3;

export async function detectOrphans(db: PGlite, runningPids: Set<number>): Promise<number> {
	const orphans = await db.query<{
		id: string;
		member_id: string;
		company_id: string;
		process_pid: number | null;
		process_loss_retry_count: number;
	}>(
		`SELECT id, member_id, company_id, process_pid, process_loss_retry_count
		 FROM heartbeat_runs
		 WHERE status = $1::heartbeat_run_status
		   AND started_at < now() - interval '5 minutes'`,
		[HeartbeatRunStatus.Running],
	);

	let orphanCount = 0;

	for (const run of orphans.rows) {
		if (run.process_pid && runningPids.has(run.process_pid)) {
			continue;
		}

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
