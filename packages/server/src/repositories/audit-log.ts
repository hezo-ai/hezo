/**
 * Data access for the audit log, which is read at three scopes that are all
 * views over one table (see the audit-log routes):
 *   - team:     team_id = :id  (optional ?project_id= narrows it)
 *   - project:  project_id = :id
 *   - instance: no scope filter (every team + instance-level rows)
 *
 * The raw version threaded a hand-built `$1/$idx` list through a count + a page
 * query that had to share an identical, string-concatenated WHERE. Here the
 * scope + optional entity/action/date filters are built once as a predicate
 * (via a standalone expression builder) and applied to both queries, so the
 * count and the page can't drift; the actor-name COALESCE and team-name joins
 * read directly.
 */
import type { PGlite } from '@electric-sql/pglite';
import { type Expression, expressionBuilder, type SqlBool } from 'kysely';
import { type DB, getKysely } from '../db/kysely';

export type AuditLogScope =
	| { kind: 'team'; teamId: string; projectId?: string }
	| { kind: 'project'; projectId: string }
	| { kind: 'instance' };

export interface AuditLogFilters {
	entityType?: string;
	action?: string;
	/** ISO timestamps (inclusive). */
	from?: string;
	to?: string;
}

export interface AuditLogRow {
	id: string;
	team_id: string | null;
	project_id: string | null;
	actor_type: string;
	actor_member_id: string | null;
	action: string;
	entity_type: string;
	entity_id: string | null;
	details: Record<string, unknown>;
	created_at: string;
	actor_name: string | null;
	team_name: string | null;
}

export interface AuditLogPage {
	rows: AuditLogRow[];
	total: number;
}

/** Scope + optional filters as a single predicate, reused by the count and the page. */
function auditConditions(scope: AuditLogScope, filters: AuditLogFilters): Expression<SqlBool>[] {
	const eb = expressionBuilder<DB, 'audit_log'>();
	const conds: Expression<SqlBool>[] = [];

	if (scope.kind === 'team') {
		conds.push(eb('audit_log.team_id', '=', scope.teamId));
		if (scope.projectId) conds.push(eb('audit_log.project_id', '=', scope.projectId));
	} else if (scope.kind === 'project') {
		conds.push(eb('audit_log.project_id', '=', scope.projectId));
	}

	if (filters.entityType) conds.push(eb('audit_log.entity_type', '=', filters.entityType));
	if (filters.action) conds.push(eb('audit_log.action', '=', filters.action));
	if (filters.from) conds.push(eb('audit_log.created_at', '>=', filters.from));
	if (filters.to) conds.push(eb('audit_log.created_at', '<=', filters.to));

	return conds;
}

export async function listAuditLog(
	db: PGlite,
	scope: AuditLogScope,
	filters: AuditLogFilters,
	pagination: { perPage: number; offset: number },
): Promise<AuditLogPage> {
	const k = getKysely(db);
	const conds = auditConditions(scope, filters);

	const total = await k
		.selectFrom('audit_log')
		.select((eb) => eb.fn.countAll<number>().as('count'))
		.$if(conds.length > 0, (qb) => qb.where((eb) => eb.and(conds)))
		.executeTakeFirstOrThrow();

	const rows = await k
		.selectFrom('audit_log')
		.leftJoin('members as m', 'm.id', 'audit_log.actor_member_id')
		.leftJoin('member_agents as ma', 'ma.id', 'audit_log.actor_member_id')
		.leftJoin('teams as t', 't.id', 'audit_log.team_id')
		.select((eb) => [
			'audit_log.id',
			'audit_log.team_id',
			'audit_log.project_id',
			'audit_log.actor_type',
			'audit_log.actor_member_id',
			'audit_log.action',
			'audit_log.entity_type',
			'audit_log.entity_id',
			'audit_log.details',
			'audit_log.created_at',
			eb.fn.coalesce('ma.title', 'm.display_name').as('actor_name'),
			't.name as team_name',
		])
		.$if(conds.length > 0, (qb) => qb.where((eb) => eb.and(conds)))
		.orderBy('audit_log.created_at', 'desc')
		.limit(pagination.perPage)
		.offset(pagination.offset)
		.execute();

	return { rows: rows as AuditLogRow[], total: Number(total.count) };
}
