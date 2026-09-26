import type { Queryable } from '../../database';
import type { CodeMigration } from '../../migrate';

/**
 * Pace a subscription's usage window, give every credential a model, and record
 * what a run stopped on and which image it ran in.
 *
 * In order:
 *
 * 1. **The usage window on the credential.** The percent used, the window's
 *    length and reset as the provider last reported them, when that report was
 *    read, and the admin's daily share (null is the even default). Dispatch reads
 *    them with the credential row it already selects, so pacing costs no query.
 * 2. **Why a run stopped, and its image**, on `heartbeat_runs`: a run stopped for
 *    size holds its task until a person replies, and the image names the CLI
 *    versions the run had.
 * 3. **The image a pooled container was built from**, so a container from an
 *    older release is rebuilt rather than reused with an older CLI.
 * 4. **A model on every credential that had none.** A credential with no model
 *    let its CLI choose, and a CLI upgrade moved a whole fleet onto a model that
 *    spends an allowance about twice as fast. Each such credential gets its
 *    provider's pinned model: the refreshed pin for an API key, whose catalog it
 *    was read from, and the fallback below for a subscription, whose catalog is a
 *    different one. A local runner has no pin and keeps none; its operator picks
 *    one of the models they pulled. What was set, and what still needs a choice,
 *    is recorded for the first boot to post as one notice.
 *
 * A code migration because step 4 chooses per row from values SQL cannot hold.
 * The fallbacks are copied here, frozen: the shared pins may move after this has
 * shipped, and a migration must do the same thing on every instance.
 */

/** The `system_meta` key the first boot reads the model notice from. */
export const DEFAULT_MODEL_BACKFILL_META_KEY = 'default_model_backfill';

/** One credential this migration gave a model, or could not. */
export interface DefaultModelBackfill {
	label: string;
	provider: string;
	/** The model it now runs on, or null when it still needs the operator's choice. */
	model: string | null;
}

/** The provider pins' fallbacks as they stood when this migration shipped. */
const FROZEN_FALLBACK_MODELS: Readonly<Record<string, string>> = {
	anthropic: 'claude-opus-5',
	openai: 'gpt-5.6-sol',
	google: 'gemini-3.6-flash',
	deepseek: 'deepseek-v4-pro',
	z_ai: 'GLM-4.7',
	kimi: 'kimi-k3',
	x_ai: 'grok-4.5',
	openrouter: 'openrouter/auto',
};

export const migration082AllowancePacing: CodeMigration = {
	// Explicit, stable - a minifier rewriting run.toString() must not shift it.
	checksum: '082_allowance_pacing_v1',
	run: async (db: Queryable) => {
		await db.exec(`
			ALTER TABLE ai_provider_configs
				ADD COLUMN IF NOT EXISTS allowance_used_percent        REAL,
				ADD COLUMN IF NOT EXISTS allowance_window_minutes      INTEGER,
				ADD COLUMN IF NOT EXISTS allowance_resets_at           TIMESTAMPTZ,
				ADD COLUMN IF NOT EXISTS allowance_seen_at             TIMESTAMPTZ,
				ADD COLUMN IF NOT EXISTS allowance_daily_share_percent REAL;
			ALTER TABLE heartbeat_runs
				ADD COLUMN IF NOT EXISTS stop_reason   TEXT,
				ADD COLUMN IF NOT EXISTS image_version TEXT;
			ALTER TABLE container_pool_members
				ADD COLUMN IF NOT EXISTS image_version TEXT;
		`);

		const missing = await db.query<{
			id: string;
			label: string;
			provider: string;
			auth_method: string;
		}>(
			`SELECT id, label, provider::text AS provider, auth_method::text AS auth_method
			   FROM ai_provider_configs
			  WHERE default_model IS NULL OR btrim(default_model) = ''
			  ORDER BY created_at, id`,
		);
		if (missing.rows.length === 0) return;

		const pins = await db.query<{ key: string; value: string }>(
			`SELECT key, value FROM system_meta WHERE key LIKE 'model\\_pin:%'`,
		);
		const refreshedPin = new Map(
			pins.rows.map((r) => [r.key.slice('model_pin:'.length), r.value.trim()]),
		);

		const record: DefaultModelBackfill[] = [];
		for (const row of missing.rows) {
			const model =
				(row.auth_method === 'subscription' ? null : refreshedPin.get(row.provider) || null) ??
				FROZEN_FALLBACK_MODELS[row.provider] ??
				null;
			if (model) {
				await db.query('UPDATE ai_provider_configs SET default_model = $2 WHERE id = $1', [
					row.id,
					model,
				]);
			}
			record.push({ label: row.label, provider: row.provider, model });
		}
		await db.query(
			`INSERT INTO system_meta (key, value) VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			[DEFAULT_MODEL_BACKFILL_META_KEY, JSON.stringify(record)],
		);
	},
};
