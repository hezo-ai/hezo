/**
 * Data access for a user's per-team UI state, stored in member_users.settings.
 *
 * The PATCH is a jsonb deep-merge (`settings || $patch::jsonb`) so a partial
 * update keeps sibling keys — the one spot that needs a sql fragment, kept
 * narrow and typed via the query builder around it.
 */
import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'kysely';
import { getKysely } from '../db/kysely';

/** The member_users row for this user in this team (settings + its id), or undefined. */
export function findMemberUserForTeam(db: PGlite, userId: string, teamId: string) {
	return getKysely(db)
		.selectFrom('members as m')
		.innerJoin('member_users as mu', 'mu.id', 'm.id')
		.select(['mu.id', 'mu.settings'])
		.where('mu.user_id', '=', userId)
		.where('m.team_id', '=', teamId)
		.executeTakeFirst();
}

/** Shallow-merge the patch into settings (jsonb ||) and return the merged blob. */
export async function mergeMemberUserSettings(
	db: PGlite,
	memberUserId: string,
	patch: unknown,
): Promise<Record<string, unknown>> {
	const row = await getKysely(db)
		.updateTable('member_users')
		.set({ settings: sql<string>`settings || ${JSON.stringify(patch)}::jsonb` })
		.where('id', '=', memberUserId)
		.returning('settings')
		.executeTakeFirstOrThrow();
	return row.settings;
}
