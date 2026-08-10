import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '054_collapse_kimi_code_provider.sql';

/**
 * 054 folds the `kimi_code` provider back into `kimi`, now that a credential
 * carries its own runtime. The point of the migration is that nothing is lost
 * and nothing silently changes CLI: a re-pointed credential must come out with
 * its encrypted secret and every other field intact AND with `runtime = 'kimi'`,
 * because its old provider defaulted to Kimi Code and a NULL under `kimi` would
 * move it onto Claude Code without telling anyone.
 */
describe('054_collapse_kimi_code_provider migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	/** A `kimi_code` credential whose label is free on the `kimi` side. */
	let plainId: string;
	/** A `kimi_code` credential whose label is already taken by a `kimi` row. */
	let clashingId: string;
	/** The `kimi` row it clashes with — must be left completely alone. */
	let incumbentId: string;
	/** An unrelated provider, to prove the UPDATEs are scoped. */
	let anthropicId: string;
	let kimiCodeAgentId: string;
	let anthropicAgentId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 053 — 'kimi_code' still selectable

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;

		const mkConfig = async (
			provider: string,
			label: string,
			credential: string,
			extra: { isDefault?: boolean; model?: string | null } = {},
		) => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO ai_provider_configs
				   (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
				 VALUES ($1::ai_provider, 'api_key', $2, $3, $4, 'verified', $5) RETURNING id`,
				[provider, label, credential, extra.isDefault ?? false, extra.model ?? null],
			);
			return r.rows[0].id;
		};

		plainId = await mkConfig('kimi_code', 'Moonshot native', 'enc:plain', {
			model: 'kimi-k2.7-code',
		});
		incumbentId = await mkConfig('kimi', 'Kimi', 'enc:incumbent', { isDefault: true });
		clashingId = await mkConfig('kimi_code', 'Kimi', 'enc:clashing');
		anthropicId = await mkConfig('anthropic', 'Claude', 'enc:anthropic');

		const mkAgent = async (name: string, provider: string, model: string) => {
			const member = await h.db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, 'agent', $2) RETURNING id`,
				[teamId, name],
			);
			const memberId = member.rows[0].id;
			await h.db.query(
				`INSERT INTO member_agents (id, title, slug, model_override_provider, model_override_model)
				 VALUES ($1, $2, $3, $4::ai_provider, $5)`,
				[memberId, name, name.toLowerCase(), provider, model],
			);
			return memberId;
		};
		kimiCodeAgentId = await mkAgent('Kimster', 'kimi_code', 'kimi-k2.7-code');
		anthropicAgentId = await mkAgent('Clauden', 'anthropic', 'claude-sonnet-5');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	async function config(id: string) {
		const r = await h.db.query<{
			provider: string;
			runtime: string | null;
			label: string;
			encrypted_credential: string;
			auth_method: string;
			is_default: boolean;
			status: string;
			default_model: string | null;
		}>(
			`SELECT provider, runtime, label, encrypted_credential, auth_method, is_default, status, default_model
			   FROM ai_provider_configs WHERE id = $1`,
			[id],
		);
		return r.rows[0];
	}

	it('keeps every re-pointed credential — none are dropped', async () => {
		const count = await h.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM ai_provider_configs`,
		);
		expect(count.rows[0].n).toBe('4');
		const stragglers = await h.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM ai_provider_configs WHERE provider = 'kimi_code'`,
		);
		expect(stragglers.rows[0].n).toBe('0');
	});

	it('re-points a credential onto kimi with its secret and fields intact', async () => {
		const row = await config(plainId);
		expect(row.provider).toBe('kimi');
		expect(row.label).toBe('Moonshot native');
		expect(row.encrypted_credential).toBe('enc:plain');
		expect(row.auth_method).toBe('api_key');
		expect(row.status).toBe('verified');
		expect(row.default_model).toBe('kimi-k2.7-code');
	});

	it('pins the re-pointed credential to the Kimi Code CLI it was already running on', async () => {
		// The whole hazard: NULL here would mean "provider default", which under
		// `kimi` is Claude Code — a different CLI than the operator configured.
		expect((await config(plainId)).runtime).toBe('kimi');
		expect((await config(clashingId)).runtime).toBe('kimi');
	});

	it('suffixes a label that collides rather than failing or dropping the row', async () => {
		const moved = await config(clashingId);
		expect(moved.provider).toBe('kimi');
		expect(moved.label).toBe('Kimi (Kimi Code)');
		expect(moved.encrypted_credential).toBe('enc:clashing');
	});

	it('leaves the incumbent kimi credential completely untouched', async () => {
		const row = await config(incumbentId);
		expect(row.label).toBe('Kimi');
		expect(row.encrypted_credential).toBe('enc:incumbent');
		expect(row.is_default).toBe(true);
		// Never had a stored runtime, and must keep following the provider default.
		expect(row.runtime).toBeNull();
	});

	it('leaves an unrelated provider alone', async () => {
		const row = await config(anthropicId);
		expect(row.provider).toBe('anthropic');
		expect(row.runtime).toBeNull();
		expect(row.encrypted_credential).toBe('enc:anthropic');
	});

	it('re-points agent model overrides, keeping the model', async () => {
		const r = await h.db.query<{ p: string | null; m: string | null }>(
			`SELECT model_override_provider AS p, model_override_model AS m
			   FROM member_agents WHERE id = ANY($1::uuid[]) ORDER BY slug`,
			[[kimiCodeAgentId, anthropicAgentId]],
		);
		// Ordered by slug: clauden, kimster.
		expect(r.rows[0]).toEqual({ p: 'anthropic', m: 'claude-sonnet-5' });
		expect(r.rows[1]).toEqual({ p: 'kimi', m: 'kimi-k2.7-code' });
	});

	it('makes the prime_agent runtime selectable', async () => {
		const labels = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum
			  WHERE enumtypid = 'agent_runtime'::regtype ORDER BY enumsortorder`,
		);
		expect(labels.rows.map((r) => r.enumlabel)).toContain('prime_agent');

		// Selectable means writable, which is the thing that was broken for `grok`
		// before 048 — a runtime existing only in TypeScript fails the cast.
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Ops', 'ops', 'OPS') RETURNING id`,
			[teamId],
		);
		await h.db.query(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, runtime_type)
			 VALUES ($1, $2, 1, 'OPS-1', 'Pinned', 'prime_agent'::agent_runtime)`,
			[teamId, project.rows[0].id],
		);
		const pinned = await h.db.query<{ runtime_type: string }>(
			`SELECT runtime_type FROM tasks WHERE identifier = 'OPS-1'`,
		);
		expect(pinned.rows[0].runtime_type).toBe('prime_agent');
	});
});
