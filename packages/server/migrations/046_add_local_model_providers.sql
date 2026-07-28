-- Add the local, self-hosted model providers (`ollama`, `lmstudio`) to the
-- `ai_provider` enum so operators can point Hezo at a model runner on their own
-- hardware instead of a vendor's hosted API.
--
-- Both runners serve Anthropic's Messages API natively, so they reuse the
-- existing `claude_code` agent runtime and the `agent_runtime` enum needs no
-- change. Unlike every other provider their endpoint is per-install, so the
-- operator's base URL is stored on the config row (`ai_provider_configs.metadata`
-- -> 'base_url'); that column already exists as jsonb and needs no DDL here.
--
-- This is a purely additive enum extension. Postgres 12+ (PGlite is PG16)
-- permits ALTER TYPE ... ADD VALUE inside a transaction as long as the new
-- value is not *used* in the same transaction — this migration only adds them,
-- so it is safe under the runner's per-migration BEGIN/COMMIT. The enum is
-- referenced by several columns (ai_provider_configs.provider,
-- tasks.model_override_provider, cost_entries.provider, and the run table's
-- provider), none of which need rewriting: existing rows keep their values and
-- the new values simply become selectable.
ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'ollama';
ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'lmstudio';
