import type { PGlite } from '@electric-sql/pglite';
import { AuthType, COACH_AGENT_SLUG } from '@hezo/shared';
import type { AuthInfo } from './types';

export async function isCoach(db: PGlite, auth: AuthInfo): Promise<boolean> {
	if (auth.type !== AuthType.Agent) return false;
	const r = await db.query<{ slug: string }>('SELECT slug FROM member_agents WHERE id = $1', [
		auth.memberId,
	]);
	return r.rows[0]?.slug === COACH_AGENT_SLUG;
}
