import { CEO_AGENT_SLUG } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '054_agent_identity';

interface Seeded {
	teamId: string;
	/** An ordinary worker: must come out of the migration with a usable sprite. */
	engineerId: string;
	/** The CEO: keeps the portrait Hezo ships, so it must NOT be given a spec. */
	ceoId: string;
}

/**
 * The migration turns an agent's identity from "a role title and some initials"
 * into a name plus a generated avatar. Three things have to be true afterwards,
 * and none of them is "the columns exist": the agents that were already there
 * must still be there with their roles intact (the title is the role now, so
 * rewriting one would silently re-scope an agent's job), every ordinary agent
 * must come out with a renderable `avatar_spec` rather than the NULL the roster
 * cannot draw, and the CEO must come out *without* one so its shipped portrait
 * still wins.
 */
describe('054_agent_identity migration', () => {
	let h: DataPreservationHarness;
	let seeded: Seeded;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
			['team-agent-identity'],
		);
		const teamId = team.rows[0].id;

		const insertAgent = async (slug: string, title: string): Promise<string> => {
			const member = await h.db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, 'agent', $2) RETURNING id`,
				[teamId, title],
			);
			const id = member.rows[0].id;
			await h.db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, $2, $3)`, [
				id,
				title,
				slug,
			]);
			return id;
		};

		seeded = {
			teamId,
			engineerId: await insertAgent('engineer', 'Engineer'),
			ceoId: await insertAgent(CEO_AGENT_SLUG, 'CEO'),
		};

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves pre-existing agents and their roles', async () => {
		const rows = await h.db.query<{ id: string; title: string; slug: string }>(
			`SELECT ma.id, ma.title, ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id WHERE m.team_id = $1 ORDER BY ma.slug`,
			[seeded.teamId],
		);
		expect(rows.rows).toEqual([
			{ id: seeded.ceoId, title: 'CEO', slug: CEO_AGENT_SLUG },
			{ id: seeded.engineerId, title: 'Engineer', slug: 'engineer' },
		]);
	});

	it('backfills a renderable avatar spec for an ordinary agent', async () => {
		const row = await h.db.query<{ avatar_spec: { seed: string; gender: string; style: string } }>(
			`SELECT avatar_spec FROM member_agents WHERE id = $1`,
			[seeded.engineerId],
		);
		// Seeded from the agent's own id, so the face is unique and stable, and
		// the style comes from the role rather than being a generic default.
		expect(row.rows[0].avatar_spec).toEqual({
			seed: seeded.engineerId,
			gender: 'n',
			style: 'engineering',
		});
	});

	it('leaves the CEO without a spec so its shipped portrait still wins', async () => {
		const row = await h.db.query<{ avatar_spec: unknown }>(
			`SELECT avatar_spec FROM member_agents WHERE id = $1`,
			[seeded.ceoId],
		);
		expect(row.rows[0].avatar_spec).toBeNull();
	});

	it('leaves every agent unnamed, for the setup pass to fill in', async () => {
		const rows = await h.db.query<{ human_name: string | null; human_name_slug: string | null }>(
			`SELECT human_name, human_name_slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id WHERE m.team_id = $1`,
			[seeded.teamId],
		);
		expect(rows.rows.every((r) => r.human_name === null && r.human_name_slug === null)).toBe(true);
	});

	it('indexes the name handle the mention fan-out probes', async () => {
		const idx = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM pg_indexes
			 WHERE tablename = 'member_agents' AND indexname = 'member_agents_human_name_slug_idx'`,
		);
		expect(idx.rows[0].c).toBe(1);
	});
});
