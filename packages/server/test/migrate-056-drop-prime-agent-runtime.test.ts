import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '056_drop_prime_agent_runtime.sql';

/**
 * 056 retires the Prime Agent runtime, which 0.42.0 shipped - so an upgrading
 * instance can be holding rows that select it.
 *
 * The hazard is not the label, it is what reads it. Every per-runtime table in
 * `@hezo/shared` is an exhaustive `Record<AgentRuntime, …>`, so a surviving
 * `prime_agent` resolves to `undefined` where a run is assembled and fails with
 * a type error rather than a message. What this asserts is that the rows are
 * re-pointed **and kept**: an operator's credential must come back on its
 * provider's default CLI with its secret and every other field intact, never
 * dropped, and never with some other provider's rows disturbed on the way past.
 */
describe('056_drop_prime_agent_runtime migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	/** A credential the operator explicitly pinned to Prime Agent. */
	let pinnedConfigId: string;
	/** One pinned to a runtime that survives - must be left alone. */
	let codexConfigId: string;
	/** One already on the provider default (NULL) - must not be rewritten. */
	let defaultConfigId: string;
	let primeTaskId: string;
	let codexTaskId: string;
	let chatSessionId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 055 - 'prime_agent' still selectable

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Ops', 'ops', 'OPS') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;

		const mkConfig = async (label: string, credential: string, runtime: string | null) => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO ai_provider_configs
				   (provider, auth_method, label, encrypted_credential, status, default_model, runtime)
				 VALUES ('deepseek', 'api_key', $1, $2, 'verified', 'deepseek-v4-flash', $3::agent_runtime)
				 RETURNING id`,
				[label, credential, runtime],
			);
			return r.rows[0].id;
		};
		pinnedConfigId = await mkConfig('Pinned to Prime', 'enc:pinned', 'prime_agent');
		codexConfigId = await mkConfig('Pinned to Codex', 'enc:codex', 'codex');
		defaultConfigId = await mkConfig('Provider default', 'enc:default', null);

		const mkTask = async (identifier: string, runtime: string | null) => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, runtime_type)
				 VALUES ($1, $2, $3, $4, 'Pinned', $5::agent_runtime) RETURNING id`,
				[teamId, projectId, identifier === 'OPS-1' ? 1 : 2, identifier, runtime],
			);
			return r.rows[0].id;
		};
		primeTaskId = await mkTask('OPS-1', 'prime_agent');
		codexTaskId = await mkTask('OPS-2', 'codex');

		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		const session = await h.db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, restart_count)
			 VALUES ($1, $2, $3, 'prime_agent'::agent_runtime, 3) RETURNING id`,
			[member.rows[0].id, teamId, projectId],
		);
		chatSessionId = session.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	async function config(id: string) {
		const r = await h.db.query<{
			runtime: string | null;
			label: string;
			encrypted_credential: string;
			status: string;
			default_model: string | null;
		}>(
			`SELECT runtime, label, encrypted_credential, status, default_model
			   FROM ai_provider_configs WHERE id = $1`,
			[id],
		);
		return r.rows[0];
	}

	it('keeps every credential - none are dropped', async () => {
		const count = await h.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM ai_provider_configs`,
		);
		expect(count.rows[0].n).toBe('3');
	});

	it('returns a Prime-Agent-pinned credential to its provider default, intact', async () => {
		const row = await config(pinnedConfigId);
		// NULL is "this provider's default", which is what the picker offers now -
		// so the credential keeps working rather than the config disappearing.
		expect(row.runtime).toBeNull();
		expect(row.label).toBe('Pinned to Prime');
		expect(row.encrypted_credential).toBe('enc:pinned');
		expect(row.status).toBe('verified');
		expect(row.default_model).toBe('deepseek-v4-flash');
	});

	it('leaves a credential pinned to a surviving runtime alone', async () => {
		expect((await config(codexConfigId)).runtime).toBe('codex');
		expect((await config(defaultConfigId)).runtime).toBeNull();
	});

	it('clears a Prime Agent task pin and keeps every other one', async () => {
		const rows = await h.db.query<{ id: string; runtime_type: string | null }>(
			`SELECT id, runtime_type FROM tasks ORDER BY number`,
		);
		expect(rows.rows.length).toBe(2);
		expect(rows.rows.find((r) => r.id === primeTaskId)?.runtime_type).toBeNull();
		expect(rows.rows.find((r) => r.id === codexTaskId)?.runtime_type).toBe('codex');
	});

	it('lands a live CEO session on Claude Code rather than leaving it unrunnable', async () => {
		// NOT NULL, so it cannot be cleared. Claude Code is the default for every
		// provider that could reach Prime Agent - all eight carried it as an
		// alternate - and the session re-resolves its runtime on restart anyway.
		// (`chat_sessions` is 001's `ceo_sessions`, renamed by 021.)
		const r = await h.db.query<{ runtime_type: string; restart_count: number }>(
			`SELECT runtime_type, restart_count FROM chat_sessions WHERE id = $1`,
			[chatSessionId],
		);
		expect(r.rows[0].runtime_type).toBe('claude_code');
		// The rest of the session row is untouched - this is a re-point, not a reset.
		expect(r.rows[0].restart_count).toBe(3);
	});

	it('leaves the enum label in place rather than rewriting the tables that use it', async () => {
		// Postgres cannot drop an enum value, and the ways around it lock `tasks`
		// and `chat_sessions` to delete a label nothing can write any more.
		const labels = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'agent_runtime'`,
		);
		expect(labels.rows.map((r) => r.enumlabel)).toContain('prime_agent');
	});
});
