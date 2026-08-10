-- Collapse the `kimi_code` provider into `kimi`, and register the Prime Agent
-- runtime.
--
-- 1. `ai_provider_configs` / `member_agents`: 'kimi_code' -> 'kimi'
--
-- 048 added `kimi_code` as a sibling of `kimi` only because a runtime was pinned
-- to its provider: the same Moonshot account and the same key, differing solely
-- in which CLI drove it. 052 gave every credential its own `runtime` column, so
-- the pair is now one provider offering two CLIs and the second label is
-- redundant.
--
-- Re-point rather than revoke. 010_retire_xai_provider_and_kimi_runtime.sql
-- revoked, but it was retiring an upstream that no longer worked; here the
-- credential is valid and keeps running on exactly the CLI it ran on before, so
-- the operator sees a relabelled row and nothing else. `runtime = 'kimi'` is
-- what preserves that: the row's stored runtime was NULL (follow the provider
-- default, which for `kimi_code` was Kimi Code), and the same NULL under `kimi`
-- would silently move it onto Claude Code.
--
-- The `UNIQUE(provider, label)` index is why the label may have to move: an
-- instance with both a "Kimi" and a "Kimi Code" credential is fine, but two rows
-- that happen to share a label are not. Suffix the incoming one rather than
-- failing the migration or dropping a credential.
--
-- Postgres cannot drop an enum value, so 'kimi_code' stays in `ai_provider`
-- forever; after this it is simply unreachable — nothing writes it and
-- `AiProvider` no longer carries it. `cost_entries.provider` and
-- `heartbeat_runs.provider` are left alone: they are historical records of what
-- actually ran, and rewriting them would falsify the archive (010 made the same
-- call).

-- Free the label before the provider changes underneath it, so the UPDATE below
-- can never collide with an existing `kimi` row.
UPDATE ai_provider_configs AS src
SET label = src.label || ' (Kimi Code)'
WHERE src.provider = 'kimi_code'
  AND EXISTS (
    SELECT 1 FROM ai_provider_configs AS other
    WHERE other.provider = 'kimi' AND other.label = src.label
  );

-- Still ambiguous if two `kimi_code` rows shared a label with two `kimi` rows,
-- or if the suffixed label is itself taken. Number the remainder.
UPDATE ai_provider_configs AS src
SET label = src.label || ' ' || src.id::text
WHERE src.provider = 'kimi_code'
  AND EXISTS (
    SELECT 1 FROM ai_provider_configs AS other
    WHERE other.provider = 'kimi' AND other.label = src.label
  );

UPDATE ai_provider_configs
SET provider = 'kimi', runtime = 'kimi'
WHERE provider = 'kimi_code';

-- Agent-level model overrides point at the provider by name. The models are
-- identical across the two labels (one Moonshot catalog), so `model_override_model`
-- stays as it is and the `model_override_requires_provider` CHECK keeps holding.
UPDATE member_agents
SET model_override_provider = 'kimi'
WHERE model_override_provider = 'kimi_code';

-- 2. `agent_runtime` += 'prime_agent'
--
-- Prime Intellect's Prime Agent CLI, offered as an alternate runtime on the
-- eight providers it can reach. Additive: no existing row references it (nothing
-- could ever have written it), so this only makes it selectable by the three
-- sites that cast a resolved runtime into the enum (`routes/tasks.ts`,
-- `mcp/tools.ts`, `services/chat-session-manager.ts`).
--
-- ADD VALUE is safe inside the runner's per-migration transaction as long as the
-- new value is not *used* in the same transaction. The UPDATEs above write only
-- pre-existing labels ('kimi'), so nothing here reads back 'prime_agent'.
ALTER TYPE agent_runtime ADD VALUE IF NOT EXISTS 'prime_agent';
