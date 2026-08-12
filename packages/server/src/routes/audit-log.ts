import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Db } from '../db/database';
import { agentDisplayNameSql } from '../lib/agent-identity';
import { buildCursorPage, encodeCursor, parseCursorPagination } from '../lib/pagination';
import { err } from '../lib/response';
import type { Env } from '../lib/types';
import { requireAdminEquivalent } from '../middleware/auth';

export const auditLogRoutes = new Hono<Env>();

/**
 * Shared reader for the audit log. `scope` pins the base WHERE clause:
 * - project:  `project_id = :id`
 * - instance: no scope filter (every project + instance-level rows)
 * Both accept the same entity_type / action / from / to filters.
 */
async function queryAuditLog(
	c: Context<Env>,
	db: Db,
	scope: { kind: 'project'; projectId: string } | { kind: 'instance' },
): Promise<Response> {
	const { limit, cursor, invalidCursor } = parseCursorPagination(c);
	if (invalidCursor) {
		return err(c, 'invalid_cursor', 'The pagination cursor is malformed.', 400);
	}
	// Egress substitution events are no longer recorded; any rows left in older
	// databases are excluded so the activity feed stays free of that noise.
	const conditions: string[] = [`al.entity_type <> 'egress_request'`];
	const params: unknown[] = [];
	let idx = 1;

	if (scope.kind === 'project') {
		conditions.push(`al.project_id = $${idx++}`);
		params.push(scope.projectId);
	}

	const entityType = c.req.query('entity_type');
	if (entityType) {
		conditions.push(`al.entity_type = $${idx++}`);
		params.push(entityType);
	}
	const action = c.req.query('action');
	if (action) {
		conditions.push(`al.action = $${idx++}`);
		params.push(action);
	}
	const from = c.req.query('from');
	if (from) {
		conditions.push(`al.created_at >= $${idx++}`);
		params.push(from);
	}
	const to = c.req.query('to');
	if (to) {
		conditions.push(`al.created_at <= $${idx++}`);
		params.push(to);
	}

	// Keyset, not offset. The instance view has no scope predicate, so counting it
	// to render a page number was a full scan of the largest never-pruned table on
	// every page load - and nothing consumed the total. `(created_at, id)` is a
	// total order, so no row is skipped or repeated when rows land mid-read.
	if (cursor) {
		conditions.push(`(al.created_at, al.id) < ($${idx}::timestamptz, $${idx + 1}::uuid)`);
		params.push(cursor.value, cursor.id);
		idx += 2;
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	// Over-fetch one row: that is what makes `has_more` exact without a count.
	const dataParams = [...params, limit + 1];
	const result = await db.query(
		`SELECT al.id, al.project_id, al.actor_type, al.actor_member_id,
		        al.actor_api_key_id,
		        al.action, al.entity_type, al.entity_id, al.details, al.created_at,
		        COALESCE(${agentDisplayNameSql('ma', 'm')}, ca.name) AS actor_name,
		        p.slug AS project_slug,
		        p.name AS project_name,
		        tk.identifier AS entity_identifier,
		        tr.identifier AS ref_task_identifier
		 FROM audit_log al
		 LEFT JOIN members m ON m.id = al.actor_member_id
		 LEFT JOIN member_agents ma ON ma.id = al.actor_member_id
		 LEFT JOIN api_keys ca ON ca.id = al.actor_api_key_id
		 LEFT JOIN projects p ON p.id = al.project_id
		 LEFT JOIN tasks tk ON al.entity_type = 'task' AND tk.id = al.entity_id
		 LEFT JOIN tasks tr ON tr.id = NULLIF(al.details->>'task_id', '')::uuid
		 ${where}
		 ORDER BY al.created_at DESC, al.id DESC
		 LIMIT $${idx}`,
		dataParams,
	);

	const page = buildCursorPage(result.rows, limit, (row) =>
		encodeCursor(new Date(row.created_at as string | Date).toISOString(), row.id as string),
	);
	return c.json(page);
}

// Per-project view — a filtered slice of the instance log scoped to the project.
auditLogRoutes.get('/projects/:projectId/audit-log', async (c) => {
	const projectId = c.get('projectId') as string;
	return queryAuditLog(c, c.get('db'), { kind: 'project', projectId });
});

// Instance-level view — every project + instance-scoped rows. Superuser only.
auditLogRoutes.get('/audit-log', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	return queryAuditLog(c, c.get('db'), { kind: 'instance' });
});
