import type { PGlite } from '@electric-sql/pglite';
import { AuthType } from '@hezo/shared';
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

export async function resolveTeamId(db: PGlite, raw: string): Promise<string | null> {
	if (UUID_RE.test(raw)) return raw;
	const result = await db.query<{ id: string }>('SELECT id FROM teams WHERE slug = $1', [raw]);
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

export async function resolveAgentId(
	db: PGlite,
	teamId: string,
	raw: string,
): Promise<string | null> {
	if (UUID_RE.test(raw)) {
		const result = await db.query<{ id: string }>(
			`SELECT m.id FROM members m
			 JOIN member_agents ma ON ma.id = m.id
			 WHERE m.team_id = $1 AND m.id = $2`,
			[teamId, raw],
		);
		return result.rows[0]?.id ?? null;
	}
	const result = await db.query<{ id: string }>(
		`SELECT m.id FROM members m
		 JOIN member_agents ma ON ma.id = m.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, raw],
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
