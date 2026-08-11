import { type AgentGender, CEO_AGENT_SLUG, COACH_AGENT_SLUG, makeAvatarSpec } from '@hezo/shared';
import type { Queryable } from '../../database';
import type { CodeMigration } from '../../migrate';

/**
 * Gives agents a human name and a generated pixel avatar.
 *
 * `member_agents.title` keeps its meaning and becomes explicitly the **role**;
 * the new `human_name` is what the UI shows in its place, and `human_name_slug`
 * makes that name a second mention handle alongside the role slug. `avatar_spec`
 * is the tiny deterministic description of the agent's sprite (see
 * `pixel-avatar.ts`) - avatars are generated from it, never uploaded.
 *
 * This is a code migration rather than plain SQL because the backfill has to run
 * the same `styleForRole` role-to-outfit mapping the app renders with; encoding
 * that table as a SQL `CASE` would be a second copy free to drift.
 *
 * Existing installations: every agent is backfilled with a spec seeded from its
 * own member id, so upgrading turns today's initials into a stable sprite with
 * no user action. `human_name` stays NULL everywhere - no existing agent has a
 * name, and the CEO/Captain assign them during the team setup pass. The CEO and
 * Coach are skipped: they keep the portraits Hezo ships for them.
 */
export const migration054AgentIdentity: CodeMigration = {
	// Explicit, stable — a minifier rewriting run.toString() must not shift it.
	checksum: '054_agent_identity_v1',
	run: async (db: Queryable) => {
		await db.exec(`
			ALTER TABLE member_agents ADD COLUMN human_name TEXT;
			ALTER TABLE member_agents ADD COLUMN human_name_slug TEXT;
			ALTER TABLE member_agents ADD COLUMN gender TEXT;
			ALTER TABLE member_agents ADD COLUMN avatar_spec JSONB;
		`);

		// Mention fan-out resolves a typed token against this column on every
		// comment write, so it ships with the column that needs it. Partial: only
		// named agents are ever probed.
		await db.exec(`
			CREATE INDEX member_agents_human_name_slug_idx
				ON member_agents (human_name_slug)
				WHERE human_name_slug IS NOT NULL;
		`);

		const agents = await db.query<{ id: string; slug: string; title: string }>(
			`SELECT id, slug, title FROM member_agents WHERE slug NOT IN ($1, $2)`,
			[CEO_AGENT_SLUG, COACH_AGENT_SLUG],
		);
		for (const agent of agents.rows) {
			const spec = makeAvatarSpec({
				seed: agent.id,
				// Nothing on an existing agent implies one, and the generator
				// resolves neutral to a concrete face from the seed.
				gender: 'n' satisfies AgentGender,
				roleSlug: agent.slug,
				roleTitle: agent.title,
			});
			await db.query(`UPDATE member_agents SET avatar_spec = $1 WHERE id = $2`, [
				JSON.stringify(spec),
				agent.id,
			]);
		}
	},
};
