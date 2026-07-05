import { AuthType, COACH_AGENT_SLUG, DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Db } from '../db/database';
import type { AuthInfo } from './types';

export async function isCoach(db: Db, auth: AuthInfo): Promise<boolean> {
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
	db: Db,
	auth: AuthInfo,
	teamId: string,
): Promise<boolean> {
	if (auth.type !== AuthType.Agent || auth.teamId !== teamId) return false;
	const r = await db.query<{ team_id: string }>('SELECT team_id FROM members WHERE id = $1', [
		auth.memberId,
	]);
	return r.rows[0]?.team_id === DEFAULT_TEAM_ID;
}

/**
 * True when the caller is an HQ instance agent (CEO/Coach) — regardless of which
 * team its run is currently scoped to. Unlike {@link isVirtualHqMemberInTeam} this
 * does not require `auth.teamId` to equal a particular team, so it recognises the
 * cross-team CEO chat session (scoped to HQ, `crossTeam`) as well as a CEO/Coach
 * task run scoped into another team. Use this for cross-team coordination actions
 * the CEO can take from anywhere; pair it with a per-team check when the action is
 * also open to that team's own Captain.
 */
export async function isHqInstanceAgent(db: Db, auth: AuthInfo): Promise<boolean> {
	if (auth.type !== AuthType.Agent) return false;
	const r = await db.query<{ team_id: string }>('SELECT team_id FROM members WHERE id = $1', [
		auth.memberId,
	]);
	return r.rows[0]?.team_id === DEFAULT_TEAM_ID;
}
