import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '066_run_cancel_reason.sql';

describe('066_run_cancel_reason migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let memberId: string;
	let cancelledRunId: string;
	let failedRunId: string;
	let succeededRunId: string;

	const CANCELLED_ERROR = 'Never started: no host process was driving this run';

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

		// A cancel written before the attribution existed - the exact shape whose
		// reason can never be recovered, and therefore the one that must read NULL
		// rather than being guessed at.
		const cancelled = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, error, exit_code, process_loss_retry_count, finished_at)
			 VALUES ($1, $2, 'cancelled'::heartbeat_run_status, $3, -1, 2, now())
			 RETURNING id`,
			[teamId, memberId, CANCELLED_ERROR],
		);
		cancelledRunId = cancelled.rows[0].id;

		const failed = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, error, exit_code, cost_cents,
			    input_tokens, output_tokens, finished_at)
			 VALUES ($1, $2, 'failed'::heartbeat_run_status, 'boom', 1, 42, 100, 200, now())
			 RETURNING id`,
			[teamId, memberId],
		);
		failedRunId = failed.rows[0].id;

		const succeeded = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, exit_code, cost_cents, finished_at)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 0, 7, now())
			 RETURNING id`,
			[teamId, memberId],
		);
		succeededRunId = succeeded.rows[0].id;

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
		}>(
			`SELECT id, status::text AS status, error, exit_code, cost_cents,
			        input_tokens, output_tokens, process_loss_retry_count
			 FROM heartbeat_runs ORDER BY created_at`,
		);
		expect(rows.rows.length).toBe(3);

		const cancelled = rows.rows.find((r) => r.id === cancelledRunId);
		expect(cancelled?.status).toBe('cancelled');
		expect(cancelled?.error).toBe(CANCELLED_ERROR);
		expect(cancelled?.exit_code).toBe(-1);
		// The lost-run ceiling reads this, so a migration that reset it would
		// silently un-bound every retry chain on the instance.
		expect(cancelled?.process_loss_retry_count).toBe(2);

		const failed = rows.rows.find((r) => r.id === failedRunId);
		expect(failed?.status).toBe('failed');
		expect(failed?.error).toBe('boom');
		expect(Number(failed?.cost_cents)).toBe(42);
		expect(Number(failed?.input_tokens)).toBe(100);
		expect(Number(failed?.output_tokens)).toBe(200);

		const succeeded = rows.rows.find((r) => r.id === succeededRunId);
		expect(succeeded?.status).toBe('succeeded');
		expect(Number(succeeded?.cost_cents)).toBe(7);
	});

	it('leaves every historical row unattributed rather than guessing', async () => {
		const rows = await h.db.query<{ id: string; cancel_reason: string | null }>(
			'SELECT id, cancel_reason FROM heartbeat_runs',
		);
		expect(rows.rows.every((r) => r.cancel_reason === null)).toBe(true);
	});

	it('accepts and reads back a reason on a new cancel', async () => {
		await h.db.query('UPDATE heartbeat_runs SET cancel_reason = $1 WHERE id = $2', [
			'abandoned',
			cancelledRunId,
		]);
		const row = await h.db.query<{ cancel_reason: string | null }>(
			'SELECT cancel_reason FROM heartbeat_runs WHERE id = $1',
			[cancelledRunId],
		);
		expect(row.rows[0].cancel_reason).toBe('abandoned');
	});
});
