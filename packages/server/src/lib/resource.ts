/**
 * Nested-resource ownership guard.
 *
 * Almost every nested route under `/api/teams/:teamId/<thing>/:id` has to prove
 * the resource belongs to the team before reading or writing it (see the
 * route-authorization rules in AGENTS.md). That check is the same shape
 * everywhere:
 *
 *   const existing = await db.query('SELECT id FROM secrets WHERE id = $1 AND team_id = $2', [id, teamId]);
 *   if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Secret not found', 404);
 *
 * `requireResourceInTeam` collapses it to one call that returns the typed row
 * on success or a 404 `Response` to short-circuit the handler — the same
 * "return-or-Response" shape as the auth guards and {@link validateBody}:
 *
 *   const row = await requireResourceInTeam<{ id: string; assignee_id: string }>(
 *     c, 'tasks', taskId, teamId, { columns: 'id, assignee_id' },
 *   );
 *   if (row instanceof Response) return row;
 *   // row is the validated, team-scoped resource
 *
 * Only the simple `id = $1 AND team_id = $2` case belongs here. Routes that
 * scope on extra columns (`project_id`, `user_id`, a jsonb path) keep their
 * inline query.
 */
import type { Context } from 'hono';
import { err } from './response';
import type { Env } from './types';

/** Postgres identifiers we emit verbatim must be developer literals, never user input. */
const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;
const SAFE_COLUMNS = /^[a-z0-9_,. ]+$/i;

/** Turn a snake_case table name into a human label: `mcp_connections` → `Mcp connection`. */
function defaultResourceName(table: string): string {
	const singular = table.endsWith('s') ? table.slice(0, -1) : table;
	const words = singular.replace(/_/g, ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function requireResourceInTeam<T = { id: string }>(
	c: Context<Env>,
	table: string,
	resourceId: string,
	teamId: string,
	options?: { columns?: string; resourceName?: string },
): Promise<T | Response> {
	const columns = options?.columns ?? 'id';
	if (!SAFE_TABLE.test(table)) {
		throw new Error(`requireResourceInTeam: unsafe table identifier '${table}'`);
	}
	if (!SAFE_COLUMNS.test(columns)) {
		throw new Error(`requireResourceInTeam: unsafe columns identifier '${columns}'`);
	}

	const db = c.get('db');
	const result = await db.query<T>(
		`SELECT ${columns} FROM ${table} WHERE id = $1 AND team_id = $2`,
		[resourceId, teamId],
	);
	const row = result.rows[0];
	if (!row) {
		const name = options?.resourceName ?? defaultResourceName(table);
		return err(c, 'NOT_FOUND', `${name} not found`, 404);
	}
	return row;
}
