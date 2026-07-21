import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '038_goal_suggestion_approval.sql';

describe('038_goal_suggestion_approval migration', () => {
	let h: DataPreservationHarness;
	let seededTeamId: string;
	let seededApprovalId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a representative approval at the prior enum schema (a hire proposal).
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		seededTeamId = team.rows[0].id;
		const approval = await h.db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload, status)
			 VALUES ($1, 'hire'::approval_type, '{"title":"Engineer"}'::jsonb, 'pending'::approval_status)
			 RETURNING id`,
			[seededTeamId],
		);
		seededApprovalId = approval.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds goal_suggestion to the approval_type enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel
			   FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'approval_type'`,
		);
		const values = r.rows.map((row) => row.enumlabel);
		expect(values).toContain('goal_suggestion');
		// The prior values are untouched.
		expect(values).toContain('hire');
		expect(values).toContain('skill_proposal');
	});

	it('preserves the pre-existing approval row', async () => {
		const kept = await h.db.query<{ type: string }>(
			`SELECT type::text AS type FROM approvals WHERE id = $1`,
			[seededApprovalId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0].type).toBe('hire');
	});

	it('accepts a new approval row with type=goal_suggestion', async () => {
		const inserted = await h.db.query<{ type: string }>(
			`INSERT INTO approvals (team_id, type, payload, status)
			 VALUES ($1, 'goal_suggestion'::approval_type,
			         '{"title":"Reach 5k followers","check_frequency":"weekly"}'::jsonb,
			         'pending'::approval_status)
			 RETURNING type::text AS type`,
			[seededTeamId],
		);
		expect(inserted.rows[0].type).toBe('goal_suggestion');
	});
});
