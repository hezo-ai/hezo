import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '079_role_prompt_sync.sql';

describe('079_role_prompt_sync migration', () => {
	let h: DataPreservationHarness;
	let approvalId: string;
	let teamId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 079

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;

		// A decision already standing on the instance, on one of the existing types.
		const approval = await h.db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'hire'::approval_type, $2::jsonb) RETURNING id`,
			[teamId, JSON.stringify({ type: 'hire', role: 'engineer' })],
		);
		approvalId = approval.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('keeps the decisions already standing on the instance', async () => {
		const row = await h.db.query<{ type: string; status: string; payload: { role: string } }>(
			`SELECT type::text AS type, status::text AS status, payload FROM approvals WHERE id = $1`,
			[approvalId],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].type).toBe('hire');
		expect(row.rows[0].status).toBe('pending');
		expect(row.rows[0].payload.role).toBe('engineer');
	});

	it('admits the new approval type, which is the change taking effect', async () => {
		const values = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'approval_type'`,
		);
		expect(values.rows.map((r) => r.enumlabel)).toContain('role_update');

		// The value existing is not the same as it being usable - that is the trap
		// ADD VALUE sets inside a transaction, and the reason nothing below it in the
		// migration may name the value.
		await expect(
			h.db.query(
				`INSERT INTO approvals (team_id, type, payload)
				 VALUES ($1, 'role_update'::approval_type, $2::jsonb)`,
				[teamId, JSON.stringify({ type: 'role_update', member_id: 'x' })],
			),
		).resolves.toBeDefined();
	});

	it('indexes the per-agent lookup the detector makes on every boot', async () => {
		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE tablename = 'approvals'`,
		);
		expect(idx.rows.map((r) => r.indexname)).toContain('idx_approvals_type_status_member');
	});
});
