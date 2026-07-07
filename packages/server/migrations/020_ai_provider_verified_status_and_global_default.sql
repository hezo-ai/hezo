-- AI provider configs carried a `status` of 'active' for any healthy key, and a
-- per-provider `is_default` flag (one default per provider type). This migration
-- makes two aligned changes:
--
--   1. Rename the healthy status to 'verified' — a stored key has been checked
--      against the provider (the add flow live-verifies, and the Verify action now
--      persists the result), so 'verified' is the truthful label. 'invalid' and
--      'revoked' are unchanged.
--   2. Make the default a single instance-wide flag rather than one-per-provider,
--      so an operator can pick exactly one provider config as THE default used by
--      agent runs. The runtime resolver already orders `is_default DESC,
--      created_at ASC`, so a single global default is honoured without further code.
--
-- Existing rows are preserved throughout — only the `status` string and the
-- `is_default` flag move.

-- 1. Rename the healthy status 'active' -> 'verified'.
ALTER TABLE ai_provider_configs ALTER COLUMN status SET DEFAULT 'verified';
UPDATE ai_provider_configs SET status = 'verified', updated_at = now() WHERE status = 'active';

-- 2. Collapse per-provider defaults to ONE instance-wide default: keep the oldest
-- currently-default config, clear the rest (rows are preserved, only the flag moves).
UPDATE ai_provider_configs SET is_default = false, updated_at = now()
WHERE is_default = true
  AND id <> (
    SELECT id FROM ai_provider_configs WHERE is_default = true ORDER BY created_at ASC LIMIT 1
  );

-- Replace the per-provider partial-unique index with a global one. In the partial
-- (WHERE is_default) the indexed expression is always true, so at most one row can
-- carry the default flag instance-wide.
DROP INDEX IF EXISTS ai_provider_configs_default_per_provider;
CREATE UNIQUE INDEX ai_provider_configs_single_default
    ON ai_provider_configs ((is_default)) WHERE is_default;
