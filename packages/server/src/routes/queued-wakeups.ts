import { WakeupStatus, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { resolveActorMemberId, resolveTaskId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { recordWakeupCancelled } from '../services/task-events';

const log = logger.child('routes');

export const queuedWakeupsRoutes = new Hono<Env>();

queuedWakeupsRoutes.get('/teams/:teamId/tasks/:taskId/queued-wakeups', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const result = await db.query(
		`SELECT w.id, w.member_id,
		        COALESCE(ma.title, m.display_name) AS member_name,
		        w.source, w.created_at, w.coalesced_count, w.last_skipped_reason
		 FROM agent_wakeup_requests w
		 JOIN members m ON m.id = w.member_id
		 LEFT JOIN member_agents ma ON ma.id = w.member_id
		 WHERE w.team_id = $1
		   AND w.status = $2::wakeup_status
		   AND w.payload->>'task_id' = $3::text
		 ORDER BY w.created_at ASC`,
		[teamId, WakeupStatus.Queued, taskId],
	);

	return ok(c, { wakeups: result.rows });
});

queuedWakeupsRoutes.post(
	'/teams/:teamId/tasks/:taskId/queued-wakeups/:wakeupId/cancel',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
		const wakeupId = c.req.param('wakeupId');

		const lookup = await db.query<{ status: string; member_id: string }>(
			`SELECT status, member_id FROM agent_wakeup_requests
			 WHERE id = $1 AND team_id = $2 AND payload->>'task_id' = $3::text`,
			[wakeupId, teamId, taskId],
		);
		const row = lookup.rows[0];
		// 404 (not 403) for unknown / wrong-team / wrong-task to avoid leaking existence.
		if (!row) return err(c, 'NOT_FOUND', 'Queued wakeup not found', 404);
		if (row.status !== WakeupStatus.Queued) {
			return err(c, 'CONFLICT', `Wakeup is already ${row.status} and cannot be cancelled`, 409);
		}

		// Race-safe: the 5s dispatcher (processWakeups) may flip queued->claimed
		// between the lookup and here. The conditional WHERE guards against it.
		const updated = await db.query<{ id: string }>(
			`UPDATE agent_wakeup_requests
			    SET status = $1::wakeup_status, completed_at = now()
			  WHERE id = $2 AND status = $3::wakeup_status
			 RETURNING id`,
			[WakeupStatus.Cancelled, wakeupId, WakeupStatus.Queued],
		);
		if (updated.rows.length === 0) {
			return err(c, 'CONFLICT', 'Wakeup is no longer queued and cannot be cancelled', 409);
		}

		broadcastChange(c, wsRoom.team(teamId), 'agent_wakeup_requests', 'UPDATE', {
			id: wakeupId,
			team_id: teamId,
			task_id: taskId,
			member_id: row.member_id,
			status: WakeupStatus.Cancelled,
		});

		const nameRes = await db.query<{ member_name: string }>(
			`SELECT COALESCE(ma.title, m.display_name) AS member_name
			 FROM members m LEFT JOIN member_agents ma ON ma.id = m.id
			 WHERE m.id = $1`,
			[row.member_id],
		);
		const agentName = nameRes.rows[0]?.member_name ?? 'an agent';
		const actorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
		try {
			await recordWakeupCancelled(
				db,
				teamId,
				taskId,
				wakeupId,
				agentName,
				actorMemberId,
				c.get('wsManager'),
			);
		} catch (e) {
			log.error('Failed to record wakeup cancellation comment:', e);
		}

		return ok(c, { cancelled: true });
	},
);
