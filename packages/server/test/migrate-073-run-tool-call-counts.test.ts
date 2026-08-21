import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '073_run_tool_call_counts.sql';

describe('073_run_tool_call_counts migration', () => {
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

		// A run recorded at the prior schema, carrying the columns a real one would -
		// including migration 056's counts, so the two are shown to coexist rather
		// than one being mistaken for the other.
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, exit_code, input_tokens, output_tokens, mcp_tool_counts)
			 VALUES ($1, $2, 'succeeded', 0, 1200, 340, $3::jsonb) RETURNING id`,
			[teamId, memberId, JSON.stringify({ hezo: 82, typefully: 25 })],
		);
		runId = run.rows[0]?.id ?? '';

		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('adds a nullable jsonb tool_call_counts column', async () => {
		const col = await h.db.query<{ data_type: string; is_nullable: string }>(
			`SELECT data_type, is_nullable FROM information_schema.columns
			 WHERE table_name = 'heartbeat_runs' AND column_name = 'tool_call_counts'`,
		);
		expect(col.rows.length).toBe(1);
		expect(col.rows[0]?.data_type).toBe('jsonb');
		expect(col.rows[0]?.is_nullable).toBe('YES');
	});

	it('preserves the pre-existing run, its usage, and its offered-tool counts', async () => {
		const kept = await h.db.query<{
			status: string;
			exit_code: number;
			input_tokens: number;
			output_tokens: number;
			mcp_tool_counts: Record<string, number>;
			tool_call_counts: unknown;
		}>(
			`SELECT status, exit_code, input_tokens, output_tokens, mcp_tool_counts, tool_call_counts
			 FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0]?.status).toBe('succeeded');
		expect(kept.rows[0]?.exit_code).toBe(0);
		expect(kept.rows[0]?.input_tokens).toBe(1200);
		expect(kept.rows[0]?.output_tokens).toBe(340);
		// Migration 056's column is untouched by this one. The two answer different
		// questions - offered vs called - and must not be conflated.
		expect(kept.rows[0]?.mcp_tool_counts).toEqual({ hezo: 82, typefully: 25 });
		// A run predating the column reads as "not instrumented", never as a run that
		// called nothing - the distinction the column exists to carry.
		expect(kept.rows[0]?.tool_call_counts).toBeNull();
	});

	it('round-trips a per-tool call count', async () => {
		await h.db.query(`UPDATE heartbeat_runs SET tool_call_counts = $1::jsonb WHERE id = $2`, [
			JSON.stringify({ mcp__hezo__create_comment: 4, Bash: 11, mcp__typefully__list_drafts: 1 }),
			runId,
		]);
		const read = await h.db.query<{ tool_call_counts: Record<string, number> }>(
			`SELECT tool_call_counts FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(read.rows[0]?.tool_call_counts).toEqual({
			mcp__hezo__create_comment: 4,
			Bash: 11,
			mcp__typefully__list_drafts: 1,
		});
	});
});
