import type { PGlite } from '@electric-sql/pglite';
import { CEO_AGENT_SLUG, OPERATIONS_PROJECT_SLUG } from '@hezo/shared';

export type OperationsAssigneeCheck = { ok: true } | { ok: false; message: string };

export const OPERATIONS_CEO_ERROR = 'Operations project issues must be assigned to the CEO';

export async function assertOperationsAssignee(
	db: PGlite,
	companyId: string,
	projectId: string,
	assigneeId: string,
): Promise<OperationsAssigneeCheck> {
	const projectResult = await db.query<{ is_operations: boolean }>(
		`SELECT (is_internal = true AND slug = $1) AS is_operations
		 FROM projects WHERE id = $2 AND company_id = $3`,
		[OPERATIONS_PROJECT_SLUG, projectId, companyId],
	);
	if (!projectResult.rows[0]?.is_operations) return { ok: true };

	const agentResult = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.company_id = $2`,
		[assigneeId, companyId],
	);
	if (agentResult.rows[0]?.slug === CEO_AGENT_SLUG) return { ok: true };
	return { ok: false, message: OPERATIONS_CEO_ERROR };
}
