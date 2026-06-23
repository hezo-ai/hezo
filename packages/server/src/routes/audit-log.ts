import type { PGlite } from '@electric-sql/pglite';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { buildMeta, parsePagination } from '../lib/pagination';
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
	db: PGlite,
	scope: { kind: 'project'; projectId: string } | { kind: 'instance' },
): Promise<Response> {
	const { page, perPage, offset } = parsePagination(c);
	const conditions: string[] = [];
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

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const countResult = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM audit_log al ${where}`,
		params,
	);
	const total = countResult.rows[0].count;

	const dataParams = [...params, perPage, offset];
	const result = await db.query(
		`SELECT al.id, al.project_id, al.actor_type, al.actor_member_id,
		        al.actor_connected_agent_id,
		        al.action, al.entity_type, al.entity_id, al.details, al.created_at,
		        COALESCE(ma.title, m.display_name, ca.name) AS actor_name,
		        p.slug AS project_slug,
		        p.name AS project_name,
		        tk.identifier AS entity_identifier,
		        tr.identifier AS ref_task_identifier
		 FROM audit_log al
		 LEFT JOIN members m ON m.id = al.actor_member_id
		 LEFT JOIN member_agents ma ON ma.id = al.actor_member_id
		 LEFT JOIN connected_agents ca ON ca.id = al.actor_connected_agent_id
		 LEFT JOIN projects p ON p.id = al.project_id
		 LEFT JOIN tasks tk ON al.entity_type = 'task' AND tk.id = al.entity_id
		 LEFT JOIN tasks tr ON tr.id = NULLIF(al.details->>'task_id', '')::uuid
		 ${where}
		 ORDER BY al.created_at DESC
		 LIMIT $${idx} OFFSET $${idx + 1}`,
		dataParams,
	);

	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
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
