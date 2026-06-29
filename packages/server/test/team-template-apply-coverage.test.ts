import type { PGlite } from '@electric-sql/pglite';
import { CAPTAIN_AGENT_SLUG, CEO_AGENT_SLUG, DEFAULT_TEAM_ID } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	applyTemplateToTeam,
	ensureBuiltinAgents,
	ensureInstanceCeo,
	ensureInstanceCoach,
	linkTeamCaptainToInstanceCeo,
} from '../src/services/team-template-apply';
import { createTeam } from '../src/services/teams';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp, createTestProject } from './helpers/app';

let db: PGlite;
let docker: ReturnType<typeof createStubDocker>;
let dataDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	docker = createStubDocker();
	dataDir = ctx.dataDir;
});

beforeEach(async () => {
	await db.query('DELETE FROM teams WHERE id != $1', [DEFAULT_TEAM_ID]);
});

afterAll(async () => {
	await safeClose(db);
});

async function getTemplateId(name: string): Promise<string> {
	const r = await db.query<{ id: string }>('SELECT id FROM team_templates WHERE name = $1', [name]);
	return r.rows[0].id;
}

async function makeBareTeam(name: string): Promise<string> {
	// A raw team with no roster, so we can drive ensure*/link helpers explicitly.
	const r = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING id`,
		[name, `bare-${Math.random().toString(36).slice(2, 8)}`],
	);
	return r.rows[0].id;
}

async function getAgentSlugs(teamId: string): Promise<string[]> {
	const r = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 ORDER BY ma.slug`,
		[teamId],
	);
	return r.rows.map((x) => x.slug);
}

describe('ensureBuiltinAgents', () => {
	it('inserts the Captain on a fresh team, then is a no-op on the second call', async () => {
		const teamId = await makeBareTeam('Ensure Builtin Co');

		const inserted = await ensureBuiltinAgents(db, teamId);
		expect(inserted).toContain(CAPTAIN_AGENT_SLUG);
		expect(await getAgentSlugs(teamId)).toContain(CAPTAIN_AGENT_SLUG);

		// Second call: the Captain already exists -> nothing inserted (skip branch).
		const again = await ensureBuiltinAgents(db, teamId);
		expect(again).toEqual([]);
	});
});

describe('ensureInstanceCeo / ensureInstanceCoach', () => {
	it('returns the already-seeded HQ CEO/Coach member id without creating a duplicate', async () => {
		const before = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM member_agents WHERE slug = $1`,
			[CEO_AGENT_SLUG],
		);
		expect(before.rows[0].c).toBe(1);

		const ceoId = await ensureInstanceCeo(db, DEFAULT_TEAM_ID);
		expect(ceoId).toBeTruthy();
		const coachId = await ensureInstanceCoach(db, DEFAULT_TEAM_ID);
		expect(coachId).toBeTruthy();

		// Still exactly one of each — the existing-row branch returned early.
		const after = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM member_agents WHERE slug = $1`,
			[CEO_AGENT_SLUG],
		);
		expect(after.rows[0].c).toBe(1);
	});
});

describe('linkTeamCaptainToInstanceCeo', () => {
	it('points a team Captain at the instance CEO (cross-team reporting line)', async () => {
		const blankId = await getTemplateId('Blank');
		const team = await createTeam(
			{ db, docker: docker as never, dataDir },
			{ name: 'Link Captain Co', templateId: blankId },
		);

		await linkTeamCaptainToInstanceCeo(db, team.id);

		const captain = await db.query<{ reports_to: string | null }>(
			`SELECT ma.reports_to FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2`,
			[team.id, CAPTAIN_AGENT_SLUG],
		);
		const ceo = await db.query<{ id: string }>(
			`SELECT id FROM member_agents WHERE slug = $1 LIMIT 1`,
			[CEO_AGENT_SLUG],
		);
		expect(captain.rows[0].reports_to).toBe(ceo.rows[0].id);
	});

	it('is a no-op when the team has no Captain', async () => {
		const teamId = await makeBareTeam('No Captain Co');
		// No throw, no rows touched.
		await expect(linkTeamCaptainToInstanceCeo(db, teamId)).resolves.toBeUndefined();
	});

	it('is a no-op when there is no instance CEO at all', async () => {
		// Temporarily rename the CEO slug so the lookup finds none.
		await db.query(`UPDATE member_agents SET slug = 'ceo-hidden' WHERE slug = $1`, [
			CEO_AGENT_SLUG,
		]);
		try {
			const blankId = await getTemplateId('Blank');
			const team = await createTeam(
				{ db, docker: docker as never, dataDir },
				{ name: 'No CEO Link Co', templateId: blankId },
			);
			await expect(linkTeamCaptainToInstanceCeo(db, team.id)).resolves.toBeUndefined();
			const captain = await db.query<{ reports_to: string | null }>(
				`SELECT ma.reports_to FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = $2`,
				[team.id, CAPTAIN_AGENT_SLUG],
			);
			// Untouched — no CEO id to point at.
			expect(captain.rows[0].reports_to).toBeNull();
		} finally {
			await db.query(`UPDATE member_agents SET slug = $1 WHERE slug = 'ceo-hidden'`, [
				CEO_AGENT_SLUG,
			]);
		}
	});
});

describe('applyTemplateToTeam — no-op re-apply', () => {
	it('re-applying the same template changes nothing and enqueues no coherence review', async () => {
		const startupId = await getTemplateId('Startup');
		const team = await createTeam(
			{ db, docker: docker as never, dataDir },
			{ name: 'Reapply Startup Co', templateId: startupId },
		);
		// Coherence/setup tasks live in the team's own project.
		await createTestProject(db, team.id, { name: 'Reapply Project' });

		// First apply of the *same* template the team was created from: builtins
		// are identical (updateBuiltinAgent returns false) and every non-builtin
		// slug already exists (provision skips them), so the roster is unchanged.
		const result = await applyTemplateToTeam(db, team.id, startupId, { dataDir });
		expect(result.created_slugs).toEqual([]);
		expect(result.builtin_updated_slugs).toEqual([]);

		const coherence = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM tasks
			 WHERE team_id = $1 AND labels @> '["team-coherence-review"]'::jsonb`,
			[team.id],
		);
		expect(coherence.rows[0].count).toBe(0);
	});
});
