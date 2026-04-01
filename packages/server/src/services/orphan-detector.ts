import type { PGlite } from '@electric-sql/pglite';
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
		 WHERE status = 'running'::heartbeat_run_status
		   AND started_at < now() - interval '5 minutes'`,
		[],
	);

	let orphanCount = 0;

	for (const run of orphans.rows) {
		if (run.process_pid && runningPids.has(run.process_pid)) {
			continue;
		}

		orphanCount++;

		await db.query(
			`UPDATE heartbeat_runs
			 SET status = 'failed'::heartbeat_run_status,
			     finished_at = now(),
			     error = 'Orphaned: process no longer running',
			     process_loss_retry_count = process_loss_retry_count + 1
			 WHERE id = $1`,
			[run.id],
		);

		await db.query(
			'UPDATE execution_locks SET released_at = now() WHERE member_id = $1 AND released_at IS NULL',
			[run.member_id],
		);

		if (run.process_loss_retry_count + 1 < MAX_RETRIES) {
			await createWakeup(db, run.member_id, run.company_id, 'timer', {
				reason: 'orphan_retry',
				retry_count: run.process_loss_retry_count + 1,
			});
		} else {
			await db.query(
				`INSERT INTO approvals (company_id, type, payload)
				 VALUES ($1, 'strategy'::approval_type, $2::jsonb)`,
				[
					run.company_id,
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
