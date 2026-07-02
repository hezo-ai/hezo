-- Retire the removed xAI provider and the removed standalone Kimi runtime.
--
-- 0.10.0 dropped `x_ai` from the supported `AiProvider` roster and moved Kimi
-- from its own `kimi` runtime onto the Claude Code runtime. The enum labels
-- stay in the DB (Postgres cannot drop enum values), but rows that *actively
-- select* the removed values must be carried forward, or an upgraded instance
-- breaks:
--   * an active `ai_provider_configs.provider = 'x_ai'` row can be picked by
--     the default-provider resolver (`ORDER BY is_default DESC, created_at ASC
--     LIMIT 1`), which then finds no runtime adapter for it and fails every
--     run with "No AI provider credentials configured" even when other valid
--     providers are configured;
--   * `tasks.runtime_type = 'kimi'` resolves to no candidate providers, so the
--     pinned task can never run;
--   * `member_agents.model_override_provider = 'x_ai'` crashes the run-launch
--     path on an undefined runtime-adapter lookup.
--
-- Data is preserved, not destroyed: provider configs flip to status 'revoked'
-- (credential kept, encrypted, but never selectable by the resolver, which
-- filters on status = 'active'); task runtime pins and agent model overrides
-- fall back to NULL, i.e. "use the instance default". Historical records
-- (cost_entries.provider, heartbeat_runs.provider, ceo_sessions.runtime_type)
-- keep their original values — they are display-only and must stay accurate.
UPDATE ai_provider_configs
SET status = 'revoked', is_default = false
WHERE provider = 'x_ai' AND status <> 'revoked';

-- The CHECK constraint model_override_requires_provider means the model must
-- be cleared together with the provider.
UPDATE member_agents
SET model_override_provider = NULL, model_override_model = NULL
WHERE model_override_provider = 'x_ai';

UPDATE tasks
SET runtime_type = NULL
WHERE runtime_type = 'kimi';
