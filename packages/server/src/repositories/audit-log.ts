/**
 * Data access for the team audit log.
 *
 * The raw version threaded a hand-built `$1/$idx` parameter list through two
 * queries (count + page) that had to share an identical, string-concatenated
 * WHERE — the index bookkeeping is exactly what drifts. The query builder
 * applies each optional filter with `$if`, so adding/removing a filter is a
 * single declarative line with no positional-parameter accounting, and the
 * actor-name join (COALESCE over the agent title / member display name) reads
 * directly instead of as an interpolated string.
 */
import type { PGlite } from '@electric-sql/pglite';
import { getKysely } from '../db/kysely';

export interface AuditLogFilters {
	teamId: string;
	entityType?: string;
	action?: string;
	/** ISO timestamps (inclusive). */
	from?: string;
	to?: string;
}

export interface AuditLogRow {
	id: string;
	team_id: string;
	actor_type: string;
	actor_member_id: string | null;
	action: string;
	entity_type: string;
	entity_id: string | null;
	details: Record<string, unknown>;
	created_at: string;
	actor_name: string | null;
}

export interface AuditLogPage {
	rows: AuditLogRow[];
	total: number;
}

export async function listTeamAuditLog(
	db: PGlite,
	filters: AuditLogFilters,
	pagination: { perPage: number; offset: number },
): Promise<AuditLogPage> {
	const k = getKysely(db);

	const total = await k
		.selectFrom('audit_log as al')
		.select((eb) => eb.fn.countAll<number>().as('count'))
		.where('al.team_id', '=', filters.teamId)
		.$if(!!filters.entityType, (qb) => qb.where('al.entity_type', '=', filters.entityType ?? ''))
		.$if(!!filters.action, (qb) => qb.where('al.action', '=', filters.action ?? ''))
		.$if(!!filters.from, (qb) => qb.where('al.created_at', '>=', filters.from ?? ''))
		.$if(!!filters.to, (qb) => qb.where('al.created_at', '<=', filters.to ?? ''))
		.executeTakeFirstOrThrow();

	const rows = await k
		.selectFrom('audit_log as al')
		.leftJoin('members as m', 'm.id', 'al.actor_member_id')
		.leftJoin('member_agents as ma', 'ma.id', 'al.actor_member_id')
		.select((eb) => [
			'al.id',
			'al.team_id',
			'al.actor_type',
			'al.actor_member_id',
			'al.action',
			'al.entity_type',
			'al.entity_id',
			'al.details',
			'al.created_at',
			eb.fn.coalesce('ma.title', 'm.display_name').as('actor_name'),
		])
		.where('al.team_id', '=', filters.teamId)
		.$if(!!filters.entityType, (qb) => qb.where('al.entity_type', '=', filters.entityType ?? ''))
		.$if(!!filters.action, (qb) => qb.where('al.action', '=', filters.action ?? ''))
		.$if(!!filters.from, (qb) => qb.where('al.created_at', '>=', filters.from ?? ''))
		.$if(!!filters.to, (qb) => qb.where('al.created_at', '<=', filters.to ?? ''))
		.orderBy('al.created_at', 'desc')
		.limit(pagination.perPage)
		.offset(pagination.offset)
		.execute();

	return { rows: rows as AuditLogRow[], total: Number(total.count) };
}
