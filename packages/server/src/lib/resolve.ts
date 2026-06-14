import type { PGlite } from '@electric-sql/pglite';
import { type AuditActorType, AuthType, DEFAULT_TEAM_ID } from '@hezo/shared';
import type { AuthInfo } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveActorMemberId(
	db: PGlite,
	auth: AuthInfo,
	teamId: string,
): Promise<string | null> {
	if (auth.type === AuthType.Agent) return auth.memberId;
	if (auth.type === AuthType.Admin) {
		const result = await db.query<{ id: string }>(
			'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.team_id = $2',
			[auth.userId, teamId],
		);
		return result.rows[0]?.id ?? null;
	}
	return null;
}

/** Map an auth context to its audit actor type. Anything non-agent is an admin (board) actor. */
export function actorTypeFromAuth(auth: AuthInfo): AuditActorType {
	return auth.type === AuthType.Agent ? 'agent' : 'admin';
}

/**
 * Resolve both the audit actor type and the acting member id for a request.
 * `teamId` may be null for instance-level actions; the member id only resolves
 * within a team, so it is null at instance scope (the actor is still `admin`).
 */
export async function resolveActor(
	db: PGlite,
	auth: AuthInfo,
	teamId: string | null,
): Promise<{ actorType: AuditActorType; actorMemberId: string | null }> {
	const actorType = actorTypeFromAuth(auth);
	const actorMemberId = teamId ? await resolveActorMemberId(db, auth, teamId) : null;
	return { actorType, actorMemberId };
}

export async function resolveTeamId(db: PGlite, raw: string): Promise<string | null> {
	if (UUID_RE.test(raw)) return raw;
	const result = await db.query<{ id: string }>('SELECT id FROM teams WHERE slug = $1', [raw]);
	return result.rows[0]?.id ?? null;
}

/**
 * The single project backing a team (1:1). Lets a team-scoped principal (API key)
 * reach its project without naming it.
 */
export async function projectIdForTeam(db: PGlite, teamId: string): Promise<string | null> {
	const result = await db.query<{ id: string }>('SELECT id FROM projects WHERE team_id = $1', [
		teamId,
	]);
	return result.rows[0]?.id ?? null;
}

export async function resolveProjectId(
	db: PGlite,
	teamId: string,
	raw: string,
): Promise<string | null> {
	if (UUID_RE.test(raw)) return raw;
	const result = await db.query<{ id: string }>(
		'SELECT id FROM projects WHERE team_id = $1 AND slug = $2',
		[teamId, raw],
	);
	return result.rows[0]?.id ?? null;
}

export interface ResolvedProject {
	projectId: string;
	teamId: string;
	teamSlug: string;
	isInternal: boolean;
}

/**
 * Resolve a project from its globally-unique slug (or UUID) to the project and
 * its backing team. Project slug is the single public handle, so this resolves
 * without a team in hand.
 */
export async function resolveProject(db: PGlite, raw: string): Promise<ResolvedProject | null> {
	const result = await db.query<{
		id: string;
		team_id: string;
		team_slug: string;
		is_internal: boolean;
	}>(
		`SELECT p.id, p.team_id, t.slug AS team_slug, p.is_internal
		 FROM projects p JOIN teams t ON t.id = p.team_id
		 WHERE ${UUID_RE.test(raw) ? 'p.id = $1' : 'p.slug = $1'}`,
		[raw],
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		projectId: row.id,
		teamId: row.team_id,
		teamSlug: row.team_slug,
		isInternal: row.is_internal,
	};
}

export async function resolveTaskId(
	db: PGlite,
	teamId: string,
	raw: string,
): Promise<string | null> {
	if (UUID_RE.test(raw)) return raw;
	const result = await db.query<{ id: string }>(
		'SELECT id FROM tasks WHERE team_id = $1 AND LOWER(identifier) = LOWER($2)',
		[teamId, raw],
	);
	return result.rows[0]?.id ?? null;
}

/**
 * Resolve an agent reference (UUID or slug) within a project team. HQ agents
 * (CEO/Coach) are virtual members of every project team, so a reference that
 * misses the project team falls back to the HQ team — the project's own member
 * is preferred on any collision. This lets instance agents be addressed through
 * any project's endpoints during cross-team runs.
 */
export async function resolveAgentId(
	db: PGlite,
	teamId: string,
	raw: string,
): Promise<string | null> {
	const column = UUID_RE.test(raw) ? 'm.id' : 'ma.slug';
	const result = await db.query<{ id: string }>(
		`SELECT m.id FROM members m
		 JOIN member_agents ma ON ma.id = m.id
		 WHERE ${column} = $2 AND m.team_id IN ($1, $3)
		 ORDER BY (m.team_id = $1) DESC
		 LIMIT 1`,
		[teamId, raw, DEFAULT_TEAM_ID],
	);
	return result.rows[0]?.id ?? null;
}

export interface ProjectLocator {
	id: string;
	slug: string;
	teamId: string;
	teamSlug: string;
}

export async function getProjectLocator(
	db: PGlite,
	projectId: string,
): Promise<ProjectLocator | null> {
	const result = await db.query<{
		id: string;
		slug: string;
		team_id: string;
		team_slug: string;
	}>(
		`SELECT p.id, p.slug, p.team_id, c.slug AS team_slug
		 FROM projects p JOIN teams c ON c.id = p.team_id
		 WHERE p.id = $1`,
		[projectId],
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		id: row.id,
		slug: row.slug,
		teamId: row.team_id,
		teamSlug: row.team_slug,
	};
}
