import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '075_default_effort_high.sql';

describe('075_default_effort_high migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let agentTypeId: string;
	let memberAgentId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 075

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;

		// An agent type deliberately below the old default, and an agent sitting on
		// the old default itself - the two shapes the migration must leave alone.
		const type = await h.db.query<{ id: string }>(
			`INSERT INTO agent_types (name, slug, default_effort)
			 VALUES ('Scribe', 'scribe', 'low'::agent_effort) RETURNING id`,
		);
		agentTypeId = type.rows[0].id;

		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Robin') RETURNING id`,
			[teamId],
		);
		memberAgentId = member.rows[0].id;
		await h.db.query(
			`INSERT INTO member_agents (id, title, slug, default_effort)
			 VALUES ($1, 'Scribe', 'scribe', 'medium'::agent_effort)`,
			[memberAgentId],
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('moves both column defaults to high', async () => {
		const r = await h.db.query<{ table_name: string; column_default: string }>(
			`SELECT table_name, column_default FROM information_schema.columns
			 WHERE column_name = 'default_effort'
			   AND table_name IN ('agent_types', 'member_agents')
			 ORDER BY table_name`,
		);
		expect(r.rows.map((row) => row.table_name)).toEqual(['agent_types', 'member_agents']);
		for (const row of r.rows) {
			expect(row.column_default).toContain("'high'");
		}
	});

	it('leaves every pre-existing row on the effort it was stored with', async () => {
		const type = await h.db.query<{ default_effort: string }>(
			'SELECT default_effort FROM agent_types WHERE id = $1',
			[agentTypeId],
		);
		expect(type.rows.length).toBe(1);
		expect(type.rows[0].default_effort).toBe('low');

		// The one that matters: an agent already on 'medium' keeps it. An operator
		// who chose the old default chose it, and raising it would raise their spend.
		const agent = await h.db.query<{ default_effort: string }>(
			'SELECT default_effort FROM member_agents WHERE id = $1',
			[memberAgentId],
		);
		expect(agent.rows.length).toBe(1);
		expect(agent.rows[0].default_effort).toBe('medium');
	});

	it('lands new rows on high when the insert omits the column', async () => {
		// `POST /api/agent-types` inserts without naming default_effort, and
		// team-template-provision copies an agent type's effort onto every agent
		// provisioned from it - so this is the path the default is here to serve.
		const type = await h.db.query<{ default_effort: string }>(
			`INSERT INTO agent_types (name, slug) VALUES ('Analyst', 'analyst')
			 RETURNING default_effort`,
		);
		expect(type.rows[0].default_effort).toBe('high');

		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Sam') RETURNING id`,
			[teamId],
		);
		const agent = await h.db.query<{ default_effort: string }>(
			`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'Analyst', 'analyst')
			 RETURNING default_effort`,
			[member.rows[0].id],
		);
		expect(agent.rows[0].default_effort).toBe('high');
	});
});
