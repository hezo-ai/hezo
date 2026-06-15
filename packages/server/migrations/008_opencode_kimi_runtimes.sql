-- Add the OpenCode and Kimi Code agent runtimes and their providers.
--
--   * agent_runtime gains `opencode` and `kimi`.
--   * ai_provider gains `openrouter` (drives the OpenCode runtime) and `kimi`
--     (drives the Kimi runtime).
--
-- Postgres can't add an enum value inside a transaction (PGlite rejects
-- `ALTER TYPE ... ADD VALUE` here), and the migration runner wraps every step in
-- BEGIN/COMMIT, so recreate each type and swap the columns over — the same
-- pattern as 006. No column carries a default or NULLs that need special
-- handling; existing values cast straight across by text.

-- agent_runtime: tasks.runtime_type (nullable), ceo_sessions.runtime_type (NOT NULL)
CREATE TYPE agent_runtime_new AS ENUM ('claude_code', 'codex', 'gemini', 'opencode', 'kimi');

ALTER TABLE tasks
    ALTER COLUMN runtime_type TYPE agent_runtime_new
    USING runtime_type::text::agent_runtime_new;
ALTER TABLE ceo_sessions
    ALTER COLUMN runtime_type TYPE agent_runtime_new
    USING runtime_type::text::agent_runtime_new;

DROP TYPE agent_runtime;
ALTER TYPE agent_runtime_new RENAME TO agent_runtime;

-- ai_provider columns: member_agents.model_override_provider (nullable),
-- ai_provider_configs.provider (NOT NULL), cost_entries.provider (nullable),
-- heartbeat_runs.provider (nullable) — the last two added in 004.
CREATE TYPE ai_provider_new AS ENUM (
    'anthropic', 'openai', 'google', 'deepseek', 'z_ai', 'openrouter', 'kimi'
);

ALTER TABLE member_agents
    ALTER COLUMN model_override_provider TYPE ai_provider_new
    USING model_override_provider::text::ai_provider_new;
ALTER TABLE ai_provider_configs
    ALTER COLUMN provider TYPE ai_provider_new
    USING provider::text::ai_provider_new;
ALTER TABLE cost_entries
    ALTER COLUMN provider TYPE ai_provider_new
    USING provider::text::ai_provider_new;
ALTER TABLE heartbeat_runs
    ALTER COLUMN provider TYPE ai_provider_new
    USING provider::text::ai_provider_new;

DROP TYPE ai_provider;
ALTER TYPE ai_provider_new RENAME TO ai_provider;
