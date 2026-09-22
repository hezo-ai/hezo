import { DEFAULT_TEAM_ID, englishCount, TaskPriority, TaskStatus, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import {
	BUDGET_CONVERSION_META_KEY,
	type BudgetConversion,
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

/** How a conversion line names its budget in the notice's plain text. */
const SUBJECT_TEXT: Record<BudgetConversion['scope'], (name: string, context: string) => string> = {
	// A line names where it lives only when the row had a project or team to name:
	// "in " with nothing after it reads as a dropped word rather than as absence.
	agent: (name, context) => (context ? `The ${name} agent in ${context}` : `The ${name} agent`),
	project: (name) => `The ${name} project`,
	agent_type: (name) => `The ${name} role`,
	team_type: (name, context) => (context ? `The ${name} role in ${context}` : `The ${name} role`),
	hire_proposal: (name, context) =>
		context ? `The proposed ${name} hire in ${context}` : `The proposed ${name} hire`,
};

/** How the task explains the rate, by where it came from. */
const RATE_BASIS_TEXT: Record<BudgetConversionRecord['basis'], string> = {
	history:
		"Each dollar budget this instance had was converted at the instance's own rate over its last 30 days of runs.",
	fallback:
		'This instance had no priced runs in the last 30 days, so each dollar budget it had was converted at one million tokens per dollar.',
};

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
	const invalid = record.invalid ?? [];

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
				`Budgets used to count dollars. This release counts every token a run sends and receives instead, input (cached input included) plus output, for every run whatever its credential, and only usage from this upgrade on. ${RATE_BASIS_TEXT[record.basis] ?? RATE_BASIS_TEXT.fallback} The notice below lists each budget. Adjust any of them on the Budget page, then close this task.`,
				TaskStatus.Backlog,
				TaskPriority.Medium,
			],
		);
		const row = inserted.rows[0];
		const subject = (scope: BudgetConversion['scope'], name: string, context: string | null) =>
			(SUBJECT_TEXT[scope] ?? SUBJECT_TEXT.agent)(name, context ?? '');
		const lines = [
			...record.conversions.map(
				(c) =>
					`${subject(c.scope, c.name, c.context)}, ${c.window}: $${(c.cents / 100).toFixed(2)} became ${englishCount(c.tokens)} tokens`,
			),
			...invalid.map(
				(b) =>
					`${subject('hire_proposal', b.name, b.context)}, ${b.window}: ${b.value} was not a dollar amount, so it is now unlimited`,
			),
		];
		await postAdminNotice({
			db,
			teamId: DEFAULT_TEAM_ID,
			taskId: row.id,
			content: {
				kind: BUDGET_CONVERSION_COMMENT_KIND,
				tokens_per_cent: record.tokens_per_cent,
				basis: record.basis,
				conversions: record.conversions,
				invalid,
				text: `Budgets now count tokens, starting from this upgrade. ${record.conversions.length} dollar budget(s) were converted at ${englishCount(Math.round(record.tokens_per_cent * 100))} tokens per dollar:\n${lines.join('\n')}`,
			},
			wsManager,
		});
		return row;
	});
	if (task && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(DEFAULT_TEAM_ID), 'tasks', 'INSERT', task);
	}
}
