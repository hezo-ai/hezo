import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '056_run_mcp_tool_counts.sql';

describe('056_run_mcp_tool_counts migration', () => {
	let h: DataPreservationHarness;
	let runId: string;
	let teamId: string;
	let memberId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0]?.id ?? '';

		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Captain') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0]?.id ?? '';

		// A run recorded at the prior schema, carrying the columns a real one would.
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, exit_code, input_tokens, output_tokens)
			 VALUES ($1, $2, 'succeeded', 0, 1200, 340) RETURNING id`,
			[teamId, memberId],
		);
		runId = run.rows[0]?.id ?? '';

		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('adds a nullable jsonb mcp_tool_counts column', async () => {
		const col = await h.db.query<{ data_type: string; is_nullable: string }>(
			`SELECT data_type, is_nullable FROM information_schema.columns
			 WHERE table_name = 'heartbeat_runs' AND column_name = 'mcp_tool_counts'`,
		);
		expect(col.rows.length).toBe(1);
		expect(col.rows[0]?.data_type).toBe('jsonb');
		expect(col.rows[0]?.is_nullable).toBe('YES');
	});

	it('preserves the pre-existing run and its recorded usage', async () => {
		const kept = await h.db.query<{
			id: string;
			status: string;
			exit_code: number;
			input_tokens: number;
			output_tokens: number;
			mcp_tool_counts: unknown;
		}>(
			`SELECT id, status, exit_code, input_tokens, output_tokens, mcp_tool_counts
			 FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0]?.status).toBe('succeeded');
		expect(kept.rows[0]?.exit_code).toBe(0);
		expect(kept.rows[0]?.input_tokens).toBe(1200);
		expect(kept.rows[0]?.output_tokens).toBe(340);
		// A run that predates the column reads as "not reported", never as a zero
		// count - the distinction the column exists to carry.
		expect(kept.rows[0]?.mcp_tool_counts).toBeNull();
	});

	it('round-trips a per-server count object', async () => {
		await h.db.query(`UPDATE heartbeat_runs SET mcp_tool_counts = $1::jsonb WHERE id = $2`, [
			JSON.stringify({ hezo: 82, typefully: 25, umami: 0 }),
			runId,
		]);
		const read = await h.db.query<{ mcp_tool_counts: Record<string, number> }>(
			`SELECT mcp_tool_counts FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(read.rows[0]?.mcp_tool_counts).toEqual({ hezo: 82, typefully: 25, umami: 0 });
	});
});
