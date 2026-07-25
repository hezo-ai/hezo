import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '039_repair_marketplace_reporting_lines.sql';

async function seedAgent(
	h: DataPreservationHarness,
	teamId: string,
	slug: string,
	opts: { agentTypeId?: string | null; reportsTo?: string | null } = {},
): Promise<string> {
	const member = await h.db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'agent', $2) RETURNING id`,
		[teamId, slug],
	);
	const id = member.rows[0].id;
	await h.db.query(
		`INSERT INTO member_agents (id, title, slug, agent_type_id, reports_to)
		 VALUES ($1, $2, $3, $4, $5)`,
		[id, slug, slug, opts.agentTypeId ?? null, opts.reportsTo ?? null],
	);
	return id;
}

describe('039_repair_marketplace_reporting_lines migration', () => {
	let h: DataPreservationHarness;
	let captainId: string;
	let architectId: string;
	let researcherId: string;
	let customRoleId: string;
	let typedOrphanId: string;
	let orphanAnalystId: string;
	let captainTypeId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;

		const captainType = await h.db.query<{ id: string }>(
			`INSERT INTO agent_types (name, slug, role_description, system_prompt_template)
			 VALUES ('Captain', 'captain', 'Leads the team', 'prompt') RETURNING id`,
		);
		captainTypeId = captainType.rows[0].id;

		// The broken marketplace shape: builtin Captain, inline roster members whose
		// captain-facing reporting line was silently dropped (reports_to NULL).
		captainId = await seedAgent(h, teamId, 'captain', { agentTypeId: captainTypeId });
		architectId = await seedAgent(h, teamId, 'architect');
		// An admin-set reporting line (points at the architect) must survive untouched.
		researcherId = await seedAgent(h, teamId, 'researcher', { reportsTo: architectId });
		// A slug no marketplace manifest points at the captain stays admin-level.
		customRoleId = await seedAgent(h, teamId, 'custom-role');
		// A catalog-typed agent is not marketplace-inline and must not be rewired.
		typedOrphanId = await seedAgent(h, teamId, 'product-lead', { agentTypeId: captainTypeId });

		// A team with no captain: a matching slug there must stay untouched.
		const team2 = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('No Captain Co', 'no-captain') RETURNING id`,
		);
		orphanAnalystId = await seedAgent(h, team2.rows[0].id, 'equity-analyst');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('repoints a broken captain-report at the team captain', async () => {
		const r = await h.db.query<{ reports_to: string | null }>(
			`SELECT reports_to FROM member_agents WHERE id = $1`,
			[architectId],
		);
		expect(r.rows[0].reports_to).toBe(captainId);
	});

	it('never overwrites an existing reporting line', async () => {
		const r = await h.db.query<{ reports_to: string | null }>(
			`SELECT reports_to FROM member_agents WHERE id = $1`,
			[researcherId],
		);
		expect(r.rows[0].reports_to).toBe(architectId);
	});

	it('leaves slugs outside the marketplace manifests alone', async () => {
		const r = await h.db.query<{ reports_to: string | null }>(
			`SELECT reports_to FROM member_agents WHERE id = $1`,
			[customRoleId],
		);
		expect(r.rows[0].reports_to).toBeNull();
	});

	it('leaves catalog-typed agents alone', async () => {
		const r = await h.db.query<{ reports_to: string | null }>(
			`SELECT reports_to FROM member_agents WHERE id = $1`,
			[typedOrphanId],
		);
		expect(r.rows[0].reports_to).toBeNull();
	});

	it('leaves teams without a captain alone', async () => {
		const r = await h.db.query<{ reports_to: string | null }>(
			`SELECT reports_to FROM member_agents WHERE id = $1`,
			[orphanAnalystId],
		);
		expect(r.rows[0].reports_to).toBeNull();
	});

	it('preserves the captain row and its type', async () => {
		const r = await h.db.query<{ agent_type_id: string | null }>(
			`SELECT agent_type_id FROM member_agents WHERE id = $1`,
			[captainId],
		);
		expect(r.rows[0].agent_type_id).toBe(captainTypeId);
	});
});
