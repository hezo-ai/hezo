-- Holding a subscription credential whose usage allowance is spent, and holding
-- the work waiting on it until the allowance resets.
--
-- A spent allowance belongs to the credential, not to one run or one wakeup, and
-- the provider states when it resets. The hold lives on the credential row so
-- every run on that credential sees it before a container is claimed.
ALTER TABLE ai_provider_configs
    ADD COLUMN IF NOT EXISTS usage_limited_until TIMESTAMPTZ;

-- The earliest time the dispatcher may claim a queued wakeup. A provider refusal
-- writes it on handback, and a claim clears it. The wakeup scan reads it as a
-- residual filter on the already-bounded pending-queue index, so it needs no
-- index of its own.
ALTER TABLE agent_wakeup_requests
    ADD COLUMN IF NOT EXISTS not_before TIMESTAMPTZ;
