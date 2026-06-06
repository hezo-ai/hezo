/**
 * Data access for execution locks (a task's active read locks).
 *
 * The interesting one is acquire: the raw version was an atomic
 * `INSERT … SELECT … WHERE NOT EXISTS (…)` so a member can't take a second
 * active lock on the same task in a single statement (no read-then-write race).
 * Kysely expresses that directly — an insert whose source is a row guarded by a
 * NOT EXISTS over the table's own active rows — so the atomicity is preserved
 * while the column list and predicate are type-checked.
 */
import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'kysely';
import { getKysely } from '../db/kysely';

export function listActiveLocks(db: PGlite, taskId: string) {
	return getKysely(db)
		.selectFrom('execution_locks as el')
		.innerJoin('members as m', 'm.id', 'el.member_id')
		.leftJoin('member_agents as ma', 'ma.id', 'el.member_id')
		.select((eb) => [
			'el.id',
			'el.task_id',
			'el.member_id',
			'el.lock_type',
			'el.locked_at',
			eb.fn.coalesce('ma.title', 'm.display_name').as('member_name'),
		])
		.where('el.task_id', '=', taskId)
		.where('el.released_at', 'is', null)
		.execute();
}

/**
 * Insert a read lock unless the member already holds an active one on the task.
 * Returns the new row, or `undefined` when the guard suppressed the insert
 * (caller maps that to a 409).
 */
export function acquireLock(db: PGlite, taskId: string, memberId: string) {
	const k = getKysely(db);
	return k
		.insertInto('execution_locks')
		.columns(['task_id', 'member_id', 'lock_type'])
		.expression(
			k
				.selectNoFrom((eb) => [
					eb.val(taskId).as('task_id'),
					eb.val(memberId).as('member_id'),
					sql.lit('read').as('lock_type'),
				])
				.where((eb) =>
					eb.not(
						eb.exists(
							eb
								.selectFrom('execution_locks as existing')
								.select(sql<number>`1`.as('one'))
								.where('existing.task_id', '=', taskId)
								.where('existing.member_id', '=', memberId)
								.where('existing.released_at', 'is', null),
						),
					),
				),
		)
		.returningAll()
		.executeTakeFirst();
}

export async function releaseLocks(db: PGlite, taskId: string): Promise<void> {
	await getKysely(db)
		.updateTable('execution_locks')
		.set({ released_at: sql<string>`now()` })
		.where('task_id', '=', taskId)
		.where('released_at', 'is', null)
		.execute();
}
