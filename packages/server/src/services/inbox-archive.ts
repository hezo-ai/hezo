import type { Db } from '../db/database';

/**
 * Archive inbox items that have been seen and were seen more than the retention
 * window ago. Mentions are seen when read; approvals are seen when resolved.
 * Returns the number of rows archived across both kinds.
 */
export async function archiveOldInboxItems(db: Db, retentionDays: number): Promise<number> {
	const days = String(retentionDays);

	const mentions = await db.query<{ id: string }>(
		`UPDATE admin_mentions SET archived_at = now()
		 WHERE archived_at IS NULL
		   AND read_at IS NOT NULL
		   AND read_at < now() - ($1 || ' days')::interval
		 RETURNING id`,
		[days],
	);

	const approvals = await db.query<{ id: string }>(
		`UPDATE approvals SET archived_at = now()
		 WHERE archived_at IS NULL
		   AND status <> 'pending'::approval_status
		   AND COALESCE(resolved_at, created_at) < now() - ($1 || ' days')::interval
		 RETURNING id`,
		[days],
	);

	return mentions.rows.length + approvals.rows.length;
}
