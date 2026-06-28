import type { PGlite } from '@electric-sql/pglite';
import { AgentAdminStatus, CEO_AGENT_SLUG } from '@hezo/shared';
import { terminalStatusParams } from '../lib/sql';

/**
 * The instance-level coordination context. All coordination work — project intake,
 * hiring, coherence review, OAuth verification — lives in the single HQ project and
 * is owned by the CEO. Project-teams hold only the work they were created for.
 */
export interface CoordinationContext {
	ceoMemberId: string;
	hqProjectId: string;
	hqTeamId: string;
}

/**
 * Per-team coordination context. Team setup, coherence review and hiring are tasks
 * in the team's **own** project, actioned by the instance CEO (who runs cross-team
 * inside that project). Only pre-project / cross-project work lives in HQ.
 */
export interface TeamCoordinationContext {
	ceoMemberId: string;
	teamProjectId: string;
	teamId: string;
}

export async function loadTeamCoordinationContext(
	db: PGlite,
	teamId: string,
): Promise<TeamCoordinationContext | null> {
	const ceo = await db.query<{ id: string }>(
		`SELECT id FROM member_agents WHERE slug = $1 LIMIT 1`,
		[CEO_AGENT_SLUG],
	);
	const project = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = false LIMIT 1`,
		[teamId],
	);
	if (!ceo.rows[0] || !project.rows[0]) return null;
	return { ceoMemberId: ceo.rows[0].id, teamProjectId: project.rows[0].id, teamId };
}

export async function loadCoordinationContext(db: PGlite): Promise<CoordinationContext | null> {
	const result = await db.query<{ ceo_id: string; project_id: string; team_id: string }>(
		`SELECT ma.id AS ceo_id, p.id AS project_id, p.team_id AS team_id
		 FROM projects p
		 JOIN members m ON m.team_id = p.team_id AND m.member_type = 'agent'
		 JOIN member_agents ma ON ma.id = m.id
		 WHERE p.is_internal = true
		   AND ma.slug = $2 AND ma.admin_status = $1::agent_admin_status
		 LIMIT 1`,
		[AgentAdminStatus.Enabled, CEO_AGENT_SLUG],
	);
	const row = result.rows[0];
	if (!row) return null;
	return { ceoMemberId: row.ceo_id, hqProjectId: row.project_id, hqTeamId: row.team_id };
}

/** The single open task carrying `label`, instance-wide (coordination lives in HQ). */
export async function findOpenLabeledTask(
	db: PGlite,
	label: string,
): Promise<{ id: string; identifier: string; project_slug: string } | null> {
	// $1 is the jsonb labels param below, so the terminal-status placeholders
	// start at $2.
	const ts = terminalStatusParams(2);
	const result = await db.query<{ id: string; identifier: string; project_slug: string }>(
		`SELECT i.id, i.identifier, p.slug AS project_slug
		 FROM tasks i
		 JOIN projects p ON p.id = i.project_id
		 WHERE i.labels @> $1::jsonb
		   AND i.status NOT IN (${ts.placeholders})
		 ORDER BY i.created_at ASC
		 LIMIT 1`,
		[JSON.stringify([label]), ...ts.values],
	);
	return result.rows[0] ?? null;
}
