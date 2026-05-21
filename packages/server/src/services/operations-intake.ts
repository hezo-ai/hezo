import type { PGlite } from '@electric-sql/pglite';
import { AgentAdminStatus, CAPTAIN_AGENT_SLUG, OPERATIONS_PROJECT_SLUG } from '@hezo/shared';
import { terminalStatusParams } from '../lib/sql';

export interface CaptainOpsContext {
	captainMemberId: string;
	operationsProjectId: string;
}

export async function loadCaptainOpsContext(
	db: PGlite,
	teamId: string,
): Promise<CaptainOpsContext | null> {
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const ops = await db.query<{ id: string }>(
		`SELECT id FROM projects
		 WHERE team_id = $1 AND is_internal = true AND slug = $2
		 LIMIT 1`,
		[teamId, OPERATIONS_PROJECT_SLUG],
	);
	if (!captain.rows[0] || !ops.rows[0]) return null;
	return {
		captainMemberId: captain.rows[0].id,
		operationsProjectId: ops.rows[0].id,
	};
}

export async function findOpenLabeledIssue(
	db: PGlite,
	teamId: string,
	label: string,
): Promise<{ id: string; identifier: string; project_slug: string } | null> {
	const ts = terminalStatusParams(3);
	const result = await db.query<{ id: string; identifier: string; project_slug: string }>(
		`SELECT i.id, i.identifier, p.slug AS project_slug
		 FROM issues i
		 JOIN projects p ON p.id = i.project_id
		 WHERE i.team_id = $1
		   AND i.labels @> $2::jsonb
		   AND i.status NOT IN (${ts.placeholders})
		 ORDER BY i.created_at ASC
		 LIMIT 1`,
		[teamId, JSON.stringify([label]), ...ts.values],
	);
	return result.rows[0] ?? null;
}
