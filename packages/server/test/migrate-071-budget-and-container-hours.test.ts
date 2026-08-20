import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '071_budget_and_container_hours.sql';

/**
 * The migration does three things at once, and each has its own way of going
 * wrong on an instance that already holds data:
 *
 * - the two `heartbeat_runs` columns must arrive NULL on existing rows without
 *   disturbing the `input_tokens` sum already there,
 * - the uptime ledger's partial unique index must actually refuse a second open
 *   interval, because that is the only thing stopping a double-close billing the
 *   same minutes twice,
 * - and `SET DEFAULT 0` must leave every configured cap alone while changing what
 *   a new row gets. That distinction is the whole reason it is a default change
 *   rather than an UPDATE.
 */
describe('071_budget_and_container_hours migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let memberId: string;
	let runId: string;
	let agentTypeId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme Project', 'acme-project', 'AP') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;

		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Engineer') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;

		// An agent carrying a cap the operator chose. It must still read 3000 after
		// the default moves to 0.
		await h.db.query(
			`INSERT INTO member_agents (id, title, slug, monthly_budget_cents)
			 VALUES ($1, 'Engineer', 'engineer', 3000)`,
			[memberId],
		);

		const at = await h.db.query<{ id: string }>(
			`INSERT INTO agent_types (slug, name, description, monthly_budget_cents)
			 VALUES ('legacy', 'Legacy', 'desc', 4500) RETURNING id`,
		);
		agentTypeId = at.rows[0].id;

		// A finished run whose token sum predates the split.
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, started_at, finished_at, input_tokens, output_tokens, cost_cents)
			 VALUES ($1, $2, 'succeeded', now() - interval '1 hour', now(), 8000, 400, 12)
			 RETURNING id`,
			[teamId, memberId],
		);
		runId = run.rows[0].id;

		await h.applyTarget(TARGET);
	});

	afterAll(async () => {
		await h.close();
	});

	it('keeps the pre-existing run intact and leaves its split unknown rather than zero', async () => {
		const r = await h.db.query<{
			input_tokens: string | number;
			output_tokens: string | number;
			cost_cents: number;
			cache_read_tokens: string | number | null;
			cache_creation_tokens: string | number | null;
		}>(
			`SELECT input_tokens, output_tokens, cost_cents, cache_read_tokens, cache_creation_tokens
			 FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		const row = r.rows[0];
		expect(Number(row.input_tokens)).toBe(8000);
		expect(Number(row.output_tokens)).toBe(400);
		expect(row.cost_cents).toBe(12);
		// NULL, not 0: the split never existed for this row and no SQL can recover
		// it from the sum. Zero would be a claim that it read no cache at all.
		expect(row.cache_read_tokens).toBeNull();
		expect(row.cache_creation_tokens).toBeNull();
	});

	it('accepts a split on a new run', async () => {
		const r = await h.db.query<{ cache_read_tokens: string | number }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
			 VALUES ($1, $2, 'succeeded', 5000, 100, 4200, 300)
			 RETURNING cache_read_tokens`,
			[teamId, memberId],
		);
		expect(Number(r.rows[0].cache_read_tokens)).toBe(4200);
	});

	it('records a container uptime interval and closes it', async () => {
		const open = await h.db.query<{ id: string; ended_at: string | null }>(
			`INSERT INTO container_uptime_entries (project_id, container_id, backend, memory_bytes)
			 VALUES ($1, 'ctr-1', 'docker', 4294967296) RETURNING id, ended_at`,
			[projectId],
		);
		expect(open.rows[0].ended_at).toBeNull();

		await h.db.query(
			`UPDATE container_uptime_entries SET ended_at = now(), end_reason = 'stopped' WHERE id = $1`,
			[open.rows[0].id],
		);
		const closed = await h.db.query<{ end_reason: string; ended_at: string }>(
			`SELECT end_reason, ended_at FROM container_uptime_entries WHERE id = $1`,
			[open.rows[0].id],
		);
		expect(closed.rows[0].end_reason).toBe('stopped');
		expect(closed.rows[0].ended_at).not.toBeNull();
	});

	it('refuses a second OPEN interval for one container, but allows a closed one', async () => {
		await h.db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, backend)
			 VALUES ($1, 'ctr-2', 'docker')`,
			[projectId],
		);
		// The double-close guard: without this index an idempotent close would open
		// a second interval and bill the same minutes twice.
		await expect(
			h.db.query(
				`INSERT INTO container_uptime_entries (project_id, container_id, backend)
				 VALUES ($1, 'ctr-2', 'docker')`,
				[projectId],
			),
		).rejects.toThrow();

		// A suspend/resume cycle is two rows for one container, so a *closed*
		// interval must not block the next one.
		await h.db.query(
			`UPDATE container_uptime_entries SET ended_at = now(), end_reason = 'suspended'
			 WHERE container_id = 'ctr-2' AND ended_at IS NULL`,
		);
		await h.db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, backend)
			 VALUES ($1, 'ctr-2', 'docker')`,
			[projectId],
		);
		const n = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM container_uptime_entries WHERE container_id = 'ctr-2'`,
		);
		expect(n.rows[0].c).toBe(2);
	});

	it('keeps the hours after the project is deleted', async () => {
		// Its own team: projects are 1:1 with teams (`idx_projects_team` is UNIQUE).
		const t2 = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Doomed Co', 'doomed-co') RETURNING id`,
		);
		const p = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Doomed', 'doomed', 'DM') RETURNING id`,
			[t2.rows[0].id],
		);
		await h.db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, backend, ended_at, end_reason)
			 VALUES ($1, 'ctr-doomed', 'daytona', now(), 'destroyed')`,
			[p.rows[0].id],
		);
		await h.db.query(`DELETE FROM projects WHERE id = $1`, [p.rows[0].id]);

		const r = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM container_uptime_entries WHERE container_id = 'ctr-doomed'`,
		);
		// The hours were billed whether or not the project still exists.
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].project_id).toBeNull();
	});

	it('leaves configured budgets alone while new rows default to unlimited', async () => {
		const existing = await h.db.query<{ monthly_budget_cents: number }>(
			`SELECT monthly_budget_cents FROM member_agents WHERE id = $1`,
			[memberId],
		);
		expect(existing.rows[0].monthly_budget_cents).toBe(3000);

		const existingType = await h.db.query<{ monthly_budget_cents: number }>(
			`SELECT monthly_budget_cents FROM agent_types WHERE id = $1`,
			[agentTypeId],
		);
		expect(existingType.rows[0].monthly_budget_cents).toBe(4500);

		// A row inserted without naming the column now gets the new default.
		const fresh = await h.db.query<{ monthly_budget_cents: number }>(
			`INSERT INTO agent_types (slug, name, description)
			 VALUES ('fresh', 'Fresh', 'desc') RETURNING monthly_budget_cents`,
		);
		expect(fresh.rows[0].monthly_budget_cents).toBe(0);

		const m2 = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Fresh Agent') RETURNING id`,
			[teamId],
		);
		const freshAgent = await h.db.query<{ monthly_budget_cents: number }>(
			`INSERT INTO member_agents (id, title, slug)
			 VALUES ($1, 'Fresh Agent', 'fresh-agent')
			 RETURNING monthly_budget_cents`,
			[m2.rows[0].id],
		);
		expect(freshAgent.rows[0].monthly_budget_cents).toBe(0);
	});
});
