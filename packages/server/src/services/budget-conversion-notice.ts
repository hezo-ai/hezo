import { DEFAULT_TEAM_ID, TaskPriority, TaskStatus, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import {
	BUDGET_CONVERSION_META_KEY,
	type BudgetConversionRecord,
} from '../db/migrations/code/081_token_budgets';
import { broadcastRowChange } from '../lib/broadcast';
import { withTransaction } from '../lib/sql';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { postAdminNotice } from './comment-wakeups';
import type { WebSocketManager } from './ws';

const log = logger.child('budget-conversion-notice');

/** The system comment kind that lists the budgets the upgrade converted. */
export const BUDGET_CONVERSION_COMMENT_KIND = 'budget_conversion';

/**
 * Tell the admin which dollar budgets became token budgets, once.
 *
 * Migration 081 converts every non-zero dollar budget at the instance's own rate
 * and records what it did. This posts that record as one notice in the admin's
 * inbox, on an unassigned HQ task so no agent is woken to read it, and removes
 * the record in the same transaction so a restart cannot post it twice. An
 * instance whose budgets were all unlimited has no record and gets no notice.
 */
export async function postBudgetConversionNotice(
	db: Db,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const meta = await db.query<{ value: string }>(`SELECT value FROM system_meta WHERE key = $1`, [
		BUDGET_CONVERSION_META_KEY,
	]);
	const raw = meta.rows[0]?.value;
	if (!raw) return;
	const record = JSON.parse(raw) as BudgetConversionRecord;

	const hq = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
		[DEFAULT_TEAM_ID],
	);
	const projectId = hq.rows[0]?.id;
	if (!projectId) {
		log.warn('Budgets were converted to tokens, but there is no HQ project to post the notice on');
		return;
	}

	const task = await withTransaction(db, async () => {
		const claimed = await db.query(`DELETE FROM system_meta WHERE key = $1 RETURNING key`, [
			BUDGET_CONVERSION_META_KEY,
		]);
		if (claimed.rows.length === 0) return null;
		const { number, identifier } = await allocateTaskIdentifier(db, projectId);
		const inserted = await db.query<Record<string, unknown> & { id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, description,
			                    status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::task_status, $8::task_priority, '[]'::jsonb)
			 RETURNING *`,
			[
				DEFAULT_TEAM_ID,
				projectId,
				number,
				identifier,
				'Budgets now count tokens',
				'Budgets used to count dollars. This release counts every token a run sends and receives instead, input (cached input included) plus output, for every run whatever its credential. Each dollar budget this instance had was converted at its own recent rate; the notice below lists them. Adjust any of them on the Budget page, then close this task.',
				TaskStatus.Backlog,
				TaskPriority.Medium,
			],
		);
		const row = inserted.rows[0];
		const lines = record.conversions.map(
			(c) =>
				`${c.name} (${c.window}): $${(c.cents / 100).toFixed(2)} became ${c.tokens.toLocaleString('en-US')} tokens`,
		);
		await postAdminNotice({
			db,
			teamId: DEFAULT_TEAM_ID,
			taskId: row.id,
			content: {
				kind: BUDGET_CONVERSION_COMMENT_KIND,
				tokens_per_cent: record.tokens_per_cent,
				basis: record.basis,
				conversions: record.conversions,
				text: `Budgets now count tokens. ${record.conversions.length} dollar budget(s) were converted at ${Math.round(record.tokens_per_cent * 100).toLocaleString('en-US')} tokens per dollar:\n${lines.join('\n')}`,
			},
			wsManager,
		});
		return row;
	});
	if (task && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(DEFAULT_TEAM_ID), 'tasks', 'INSERT', task);
	}
}
