import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '069_retire_gemini_runtime_add_antigravity.sql';

describe('069_retire_gemini_runtime_add_antigravity migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let googleApiKeyId: string;
	let googleApiKeyGeminiRuntimeId: string;
	let googleSubId: string;
	let googleSubDefaultId: string;
	let anthropicId: string;
	let geminiTaskId: string;
	let codexTaskId: string;

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

		const cfg = async (
			label: string,
			authMethod: 'api_key' | 'subscription',
			credential: string,
			provider = 'google',
			runtime: string | null = null,
			isDefault = false,
		): Promise<string> => {
			const row = await h.db.query<{ id: string }>(
				`INSERT INTO ai_provider_configs
				   (provider, auth_method, label, encrypted_credential, is_default, status, runtime)
				 VALUES ($1, $2::ai_auth_method, $3, $4, $5, 'verified', $6::agent_runtime)
				 RETURNING id`,
				[provider, authMethod, label, credential, isDefault, runtime],
			);
			return row.rows[0].id;
		};

		googleApiKeyId = await cfg('g-key', 'api_key', 'enc-google-key');
		// A stored 'gemini' runtime on an API-key row: the migration leaves it
		// alone (resolution falls back to the provider default in code, not here).
		googleApiKeyGeminiRuntimeId = await cfg(
			'g-key-gem',
			'api_key',
			'enc-key-gem',
			'google',
			'gemini',
		);
		googleSubId = await cfg('g-sub', 'subscription', 'enc-google-sub');
		googleSubDefaultId = await cfg(
			'g-sub-def',
			'subscription',
			'enc-google-sub-def',
			'google',
			null,
			true,
		);
		anthropicId = await cfg('anthropic', 'api_key', 'enc-anthropic', 'anthropic');

		const task = async (
			identifier: string,
			num: number,
			runtime: string | null,
		): Promise<string> => {
			const row = await h.db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, runtime_type)
				 VALUES ($1, $2, $3, $4, $5, $6::agent_runtime) RETURNING id`,
				[teamId, projectId, num, identifier, `Task ${identifier}`, runtime],
			);
			return row.rows[0].id;
		};
		geminiTaskId = await task('AP-1', 1, 'gemini');
		codexTaskId = await task('AP-2', 2, 'codex');

		await h.applyTarget(TARGET);
	});

	afterAll(async () => {
		await h.close();
	});

	it('adds the antigravity enum label so it can be stored', async () => {
		const labels = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'agent_runtime'`,
		);
		const values = labels.rows.map((r) => r.enumlabel);
		expect(values).toContain('antigravity');
		// The old label is not dropped - stored rows still reference it.
		expect(values).toContain('gemini');
	});

	it('leaves Google API-key credentials untouched', async () => {
		const rows = await h.db.query<{
			encrypted_credential: string;
			status: string;
			runtime: string | null;
		}>(`SELECT encrypted_credential, status, runtime FROM ai_provider_configs WHERE id = ANY($1)`, [
			[googleApiKeyId, googleApiKeyGeminiRuntimeId],
		]);
		for (const r of rows.rows) expect(r.status).toBe('verified');
		const byGem = rows.rows.find((r) => r.runtime === 'gemini');
		// The stored 'gemini' runtime is preserved; code resolves it to the default.
		expect(byGem?.status).toBe('verified');
		const key = await h.db.query<{ encrypted_credential: string }>(
			`SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1`,
			[googleApiKeyId],
		);
		expect(key.rows[0].encrypted_credential).toBe('enc-google-key');
	});

	it('marks Google subscription credentials invalid, preserving the blob', async () => {
		const rows = await h.db.query<{
			id: string;
			status: string;
			encrypted_credential: string;
			is_default: boolean;
		}>(
			`SELECT id, status, encrypted_credential, is_default FROM ai_provider_configs WHERE id = ANY($1)`,
			[[googleSubId, googleSubDefaultId]],
		);
		for (const r of rows.rows) {
			expect(r.status).toBe('invalid');
			// Data preserved, not deleted.
			expect(r.encrypted_credential).toMatch(/^enc-google-sub/);
		}
		// A default subscription stays is_default so its runs fail loudly rather
		// than silently switching provider.
		const def = rows.rows.find((r) => r.id === googleSubDefaultId);
		expect(def?.is_default).toBe(true);
	});

	it('leaves non-Google credentials untouched', async () => {
		const row = await h.db.query<{ status: string; encrypted_credential: string }>(
			`SELECT status, encrypted_credential FROM ai_provider_configs WHERE id = $1`,
			[anthropicId],
		);
		expect(row.rows[0].status).toBe('verified');
		expect(row.rows[0].encrypted_credential).toBe('enc-anthropic');
	});

	it('nulls gemini-pinned tasks and keeps other pins', async () => {
		const gem = await h.db.query<{ runtime_type: string | null; title: string }>(
			`SELECT runtime_type, title FROM tasks WHERE id = $1`,
			[geminiTaskId],
		);
		expect(gem.rows[0].runtime_type).toBeNull();
		// The rest of the row survives.
		expect(gem.rows[0].title).toBe('Task AP-1');
		const codex = await h.db.query<{ runtime_type: string | null }>(
			`SELECT runtime_type FROM tasks WHERE id = $1`,
			[codexTaskId],
		);
		expect(codex.rows[0].runtime_type).toBe('codex');
	});
});
