import type { PGlite } from '@electric-sql/pglite';
import { CAPTAIN_AGENT_SLUG, INTERNAL_PROJECT_SLUG } from '@hezo/shared';

export type InternalAssigneeCheck = { ok: true } | { ok: false; message: string };

export const INTERNAL_CAPTAIN_ERROR = 'Internal project tasks must be assigned to the Captain';

export async function assertInternalAssignee(
	db: PGlite,
	teamId: string,
	projectId: string,
	assigneeId: string,
): Promise<InternalAssigneeCheck> {
	const projectResult = await db.query<{ is_internal_project: boolean }>(
		`SELECT (is_internal = true AND slug = $1) AS is_internal_project
		 FROM projects WHERE id = $2 AND team_id = $3`,
		[INTERNAL_PROJECT_SLUG, projectId, teamId],
	);
	if (!projectResult.rows[0]?.is_internal_project) return { ok: true };

	const agentResult = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.team_id = $2`,
		[assigneeId, teamId],
	);
	if (agentResult.rows[0]?.slug === CAPTAIN_AGENT_SLUG) return { ok: true };
	return { ok: false, message: INTERNAL_CAPTAIN_ERROR };
}
