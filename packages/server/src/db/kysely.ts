/**
 * Typed Kysely entry point over the shared PGlite instance.
 *
 * Phase 3 migrates raw-SQL route/service queries onto a typed query builder one
 * resource at a time. The `DB` interface below is the hand-maintained schema —
 * it grows a table only when a repository starts using it, so it stays a
 * faithful, reviewed subset rather than a giant codegen dump that drifts from
 * what's actually queried. (`PGliteIntrospector` makes information_schema
 * codegen viable later if the table count makes hand-maintenance painful — see
 * the spike — but the curated interface is clearer while the surface is small.)
 *
 * `getKysely` memoizes one `Kysely<DB>` per PGlite instance via a WeakMap, so
 * repositories can take the plain `PGlite` they already hold on the request
 * context without the app wiring a second handle or paying construction cost
 * per call. The PGlite instance is owned by the caller; the cached Kysely holds
 * no extra resources (the dialect's `destroy()` is a no-op), so the entry is
 * collected with the PGlite.
 */
import type { PGlite } from '@electric-sql/pglite';
import { type ColumnType, type Generated, Kysely } from 'kysely';
import { PGliteDialect } from './pglite-dialect';

/** Timestamp columns surface as whatever PGlite returns (matches the raw-query path). */
type Timestamp = ColumnType<string, string | undefined, string>;

export interface ApiKeysTable {
	id: Generated<string>;
	team_id: string;
	name: string;
	prefix: string;
	key_hash: string;
	last_used_at: ColumnType<string | null, string | null | undefined, string | null>;
	created_at: Generated<Timestamp>;
}

export interface AuditLogTable {
	id: Generated<string>;
	team_id: string;
	actor_type: string;
	actor_member_id: string | null;
	action: string;
	entity_type: string;
	entity_id: string | null;
	/** jsonb: read back as an object, written as a JSON string. */
	details: ColumnType<Record<string, unknown>, string, string>;
	/** Plain string (not the Timestamp alias) so date-range WHERE comparisons accept ISO strings. */
	created_at: Generated<string>;
}

export interface MembersTable {
	id: Generated<string>;
	team_id: string;
	member_type: string;
	display_name: Generated<string>;
	created_at: Generated<Timestamp>;
}

/** Only the columns the audit-log join reads; member_agents is a 1:1 extension of members. */
export interface MemberAgentsTable {
	id: string;
	title: string;
	slug: string;
}

export interface DB {
	api_keys: ApiKeysTable;
	audit_log: AuditLogTable;
	members: MembersTable;
	member_agents: MemberAgentsTable;
}

const cache = new WeakMap<PGlite, Kysely<DB>>();

export function getKysely(client: PGlite): Kysely<DB> {
	let kysely = cache.get(client);
	if (!kysely) {
		kysely = new Kysely<DB>({ dialect: new PGliteDialect(client) });
		cache.set(client, kysely);
	}
	return kysely;
}
