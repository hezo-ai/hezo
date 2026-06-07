import type { PGlite } from '@electric-sql/pglite';
import { AuthType, COACH_AGENT_SLUG, DEFAULT_TEAM_ID } from '@hezo/shared';
import type { AuthInfo } from './types';

export async function isCoach(db: PGlite, auth: AuthInfo): Promise<boolean> {
	if (auth.type !== AuthType.Agent) return false;
	const r = await db.query<{ slug: string }>('SELECT slug FROM member_agents WHERE id = $1', [
		auth.memberId,
	]);
	return r.rows[0]?.slug === COACH_AGENT_SLUG;
}

/**
 * HQ agents (CEO/Coach and anything else living in the HQ team) are virtual
 * members of every project team. During a cross-team run the JWT scopes them to
 * the run team, so they execute with full member powers inside the team they are
 * running in. True when the caller is an HQ agent whose run is scoped to `teamId`.
 */
export async function isVirtualHqMemberInTeam(
	db: PGlite,
	auth: AuthInfo,
	teamId: string,
): Promise<boolean> {
	if (auth.type !== AuthType.Agent || auth.teamId !== teamId) return false;
	const r = await db.query<{ team_id: string }>('SELECT team_id FROM members WHERE id = $1', [
		auth.memberId,
	]);
	return r.rows[0]?.team_id === DEFAULT_TEAM_ID;
}
