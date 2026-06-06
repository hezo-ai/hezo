/**
 * Data access for `api_keys`, the first Phase 3 repository.
 *
 * Each function takes the shared `PGlite` (the handle routes already hold on
 * `c.get('db')`) and runs through the memoized typed Kysely. The repository
 * owns the column list and scoping; the route keeps the key-hashing and
 * broadcast concerns. Behavior matches the raw SQL it replaced exactly — same
 * columns, same `team_id` scope, same `created_at DESC` order.
 */
import type { PGlite } from '@electric-sql/pglite';
import { getKysely } from '../db/kysely';

/** Public-safe columns (never the key_hash). */
const PUBLIC_COLUMNS = ['id', 'team_id', 'name', 'prefix', 'last_used_at', 'created_at'] as const;
const CREATED_COLUMNS = ['id', 'team_id', 'name', 'prefix', 'created_at'] as const;

export function listTeamApiKeys(db: PGlite, teamId: string) {
	return getKysely(db)
		.selectFrom('api_keys')
		.select(PUBLIC_COLUMNS)
		.where('team_id', '=', teamId)
		.orderBy('created_at', 'desc')
		.execute();
}

export function insertApiKey(
	db: PGlite,
	input: { teamId: string; name: string; prefix: string; keyHash: string },
) {
	return getKysely(db)
		.insertInto('api_keys')
		.values({
			team_id: input.teamId,
			name: input.name,
			prefix: input.prefix,
			key_hash: input.keyHash,
		})
		.returning(CREATED_COLUMNS)
		.executeTakeFirstOrThrow();
}

export async function deleteApiKey(db: PGlite, id: string): Promise<void> {
	await getKysely(db).deleteFrom('api_keys').where('id', '=', id).execute();
}
