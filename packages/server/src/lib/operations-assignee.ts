import type { PGlite } from '@electric-sql/pglite';
import { CAPTAIN_AGENT_SLUG, OPERATIONS_PROJECT_SLUG } from '@hezo/shared';

export type OperationsAssigneeCheck = { ok: true } | { ok: false; message: string };

export const OPERATIONS_CAPTAIN_ERROR = 'Operations project tasks must be assigned to the Captain';

export async function assertOperationsAssignee(
	db: PGlite,
	teamId: string,
	projectId: string,
	assigneeId: string,
): Promise<OperationsAssigneeCheck> {
	const projectResult = await db.query<{ is_operations: boolean }>(
		`SELECT (is_internal = true AND slug = $1) AS is_operations
		 FROM projects WHERE id = $2 AND team_id = $3`,
		[OPERATIONS_PROJECT_SLUG, projectId, teamId],
	);
	if (!projectResult.rows[0]?.is_operations) return { ok: true };

	const agentResult = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.team_id = $2`,
		[assigneeId, teamId],
	);
	if (agentResult.rows[0]?.slug === CAPTAIN_AGENT_SLUG) return { ok: true };
	return { ok: false, message: OPERATIONS_CAPTAIN_ERROR };
}
