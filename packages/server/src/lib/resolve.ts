import { type AuditActorType, AuthType, DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Db } from '../db/database';
import type { AuthInfo } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveActorMemberId(
	db: Db,
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

/**
 * Map an auth context to its audit actor type. An agent run is an `agent`; an
 * approved API key (the instance MCP credential) is an `api_key`; everything else
 * (board user, superuser) is an `admin`.
 */
export function actorTypeFromAuth(auth: AuthInfo): AuditActorType {
	if (auth.type === AuthType.Agent) return 'agent';
	if (auth.type === AuthType.ApiKey) return 'api_key';
	return 'admin';
}

/** The API-key identity behind a request, or null for any other principal. */
export function apiKeyIdFromAuth(auth: AuthInfo): string | null {
	return auth.type === AuthType.ApiKey ? auth.apiKeyId : null;
}

/**
 * Resolve the audit actor type, the acting member id, and the API-key id for a
 * request. `teamId` may be null for instance-level actions; the member id only
 * resolves within a team, so it is null at instance scope. An API key has no
 * member row — it is attributed via `actorApiKeyId`.
 */
export async function resolveActor(
	db: Db,
	auth: AuthInfo,
	teamId: string | null,
): Promise<{
	actorType: AuditActorType;
	actorMemberId: string | null;
	actorApiKeyId: string | null;
}> {
	const actorType = actorTypeFromAuth(auth);
	const actorMemberId = teamId ? await resolveActorMemberId(db, auth, teamId) : null;
	return { actorType, actorMemberId, actorApiKeyId: apiKeyIdFromAuth(auth) };
}

export async function resolveTeamId(db: Db, raw: string): Promise<string | null> {
	if (UUID_RE.test(raw)) return raw;
	const result = await db.query<{ id: string }>('SELECT id FROM teams WHERE slug = $1', [raw]);
	return result.rows[0]?.id ?? null;
}

export async function resolveProjectId(
	db: Db,
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
export async function resolveProject(db: Db, raw: string): Promise<ResolvedProject | null> {
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

export async function resolveTaskId(db: Db, teamId: string, raw: string): Promise<string | null> {
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
export async function resolveAgentId(db: Db, teamId: string, raw: string): Promise<string | null> {
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

export async function getProjectLocator(db: Db, projectId: string): Promise<ProjectLocator | null> {
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
