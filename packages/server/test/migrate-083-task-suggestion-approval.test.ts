import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '083_task_suggestion_approval.sql';

describe('083_task_suggestion_approval migration', () => {
	let h: DataPreservationHarness;
	let approvalId: string;
	let teamId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 083

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;

		// A goal suggestion already standing on the instance: the closest kind.
		const approval = await h.db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'goal_suggestion'::approval_type, $2::jsonb) RETURNING id`,
			[teamId, JSON.stringify({ title: 'Ship the MVP' })],
		);
		approvalId = approval.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('keeps the decisions already standing on the instance', async () => {
		const row = await h.db.query<{ type: string; status: string; payload: { title: string } }>(
			`SELECT type::text AS type, status::text AS status, payload FROM approvals WHERE id = $1`,
			[approvalId],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].type).toBe('goal_suggestion');
		expect(row.rows[0].status).toBe('pending');
		expect(row.rows[0].payload.title).toBe('Ship the MVP');
	});

	it('admits the new approval type, which is the change taking effect', async () => {
		const values = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'approval_type'`,
		);
		expect(values.rows.map((r) => r.enumlabel)).toContain('task_suggestion');

		await expect(
			h.db.query(
				`INSERT INTO approvals (team_id, type, payload)
				 VALUES ($1, 'task_suggestion'::approval_type, $2::jsonb)`,
				[teamId, JSON.stringify({ title: 'Tell the team which stocks to watch' })],
			),
		).resolves.toBeDefined();
	});
});
