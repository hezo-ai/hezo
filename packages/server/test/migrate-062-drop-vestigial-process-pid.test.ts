import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '062_drop_vestigial_process_pid.sql';

describe('062_drop_vestigial_process_pid migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let memberId: string;
	let failedRunId: string;
	let succeededRunId: string;

	const FAILED_ERROR = 'Orphaned: nothing was driving this run any more';

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Worker') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;

		const failed = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, error, exit_code, cost_cents,
			    input_tokens, output_tokens, process_loss_retry_count, finished_at)
			 VALUES ($1, $2, 'failed'::heartbeat_run_status, $3, -1, 42, 100, 200, 2, now())
			 RETURNING id`,
			[teamId, memberId, FAILED_ERROR],
		);
		failedRunId = failed.rows[0].id;

		const succeeded = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, exit_code, cost_cents, finished_at)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 0, 7, now())
			 RETURNING id`,
			[teamId, memberId],
		);
		succeededRunId = succeeded.rows[0].id;

		// The retry lineage must survive: it is what bounds the lost-run chain, and
		// it is the column deliberately kept while `process_pid` goes.
		await h.db.query('UPDATE heartbeat_runs SET retry_of_run_id = $1 WHERE id = $2', [
			succeededRunId,
			failedRunId,
		]);

		await h.applyTarget(TARGET);
	});

	afterAll(async () => {
		await h.close();
	});

	it('keeps every pre-existing run row and everything recorded on it', async () => {
		const rows = await h.db.query<{
			id: string;
			status: string;
			error: string | null;
			exit_code: number | null;
			cost_cents: number | null;
			input_tokens: number | null;
			output_tokens: number | null;
			process_loss_retry_count: number;
			retry_of_run_id: string | null;
		}>(
			`SELECT id, status::text AS status, error, exit_code, cost_cents,
			        input_tokens, output_tokens, process_loss_retry_count, retry_of_run_id
			 FROM heartbeat_runs ORDER BY created_at`,
		);
		expect(rows.rows.length).toBe(2);

		const failed = rows.rows.find((r) => r.id === failedRunId);
		expect(failed?.status).toBe('failed');
		expect(failed?.error).toBe(FAILED_ERROR);
		expect(failed?.exit_code).toBe(-1);
		expect(Number(failed?.cost_cents)).toBe(42);
		expect(Number(failed?.input_tokens)).toBe(100);
		expect(Number(failed?.output_tokens)).toBe(200);
		expect(failed?.process_loss_retry_count).toBe(2);
		expect(failed?.retry_of_run_id).toBe(succeededRunId);

		const succeeded = rows.rows.find((r) => r.id === succeededRunId);
		expect(succeeded?.status).toBe('succeeded');
		expect(Number(succeeded?.cost_cents)).toBe(7);
	});

	it('removes the column', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'heartbeat_runs' AND column_name = 'process_pid'`,
		);
		expect(cols.rows).toEqual([]);
	});

	it('keeps retry_of_run_id, which the lost-run ceiling reads', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'heartbeat_runs'
			   AND column_name IN ('retry_of_run_id', 'process_loss_retry_count')
			 ORDER BY column_name`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual([
			'process_loss_retry_count',
			'retry_of_run_id',
		]);
	});
});
