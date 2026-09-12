-- Make an agent run's cost real on a subscription, and auditable afterwards.
--
-- Three things were true together and only the combination was visible: a run on
-- OpenAI Codex under subscription auth resolved no model, so pricing returned $0
-- silently; the $0 meant no cost_entries row was written at all; and the dollar
-- budgets that gate dispatch sum that table. A live instance spent 2.3 billion
-- input tokens in seven days against a recorded $0.79.
--
-- Nothing here enforces anything. The figure for a subscription run is notional -
-- what those tokens would have cost at published API rates - so it is recorded
-- beside real spend rather than mixed into it, and every query that feeds a
-- budget keeps reading real spend alone.

-- Real spend or a notional figure. Defaulting true is the safe direction: every
-- historical row IS real spend, and an unaudited future writer that forgets this
-- column fails towards enforcement rather than silently ceasing to bill someone.
ALTER TABLE cost_entries
  ADD COLUMN IF NOT EXISTS billed BOOLEAN NOT NULL DEFAULT true;

-- `billed` is an equality predicate in front of a `created_at` range scan in
-- `getSpendByColumn`, which is the pre-dispatch budget gate, so it belongs
-- between the two. The existing (member_id, created_at) / (project_id,
-- created_at) indexes stay: the display queries read both classes at once.
CREATE INDEX IF NOT EXISTS idx_costs_member_billed_created
  ON cost_entries (member_id, billed, created_at);
CREATE INDEX IF NOT EXISTS idx_costs_project_billed_created
  ON cost_entries (project_id, billed, created_at);

-- The model the run's cost was priced from. NULL where the runtime named none,
-- which is the honest reading for every row predating this: a subscription run's
-- recorded argv carries no --model either, so nothing else on the row can say.
-- Without it, "$0 because the model was unknown" and "$0 because the model is
-- free" are the same number and completely different faults.
ALTER TABLE heartbeat_runs
  ADD COLUMN IF NOT EXISTS model TEXT;

-- Whether this run's cost is real money, snapshotted at run start.
--
-- A snapshot rather than a join through ai_provider_config_id, which is
-- ON DELETE SET NULL and which an operator can flip from subscription to API key.
-- Either would silently re-label runs that finished months ago.
ALTER TABLE heartbeat_runs
  ADD COLUMN IF NOT EXISTS cost_billed BOOLEAN NOT NULL DEFAULT true;

-- Cache rates for OpenAI models, superseding migration 014's header note that the
-- catalog carries no cache rates for anyone but Anthropic.
--
-- The feed refresh (boot, then daily) now derives these itself, so a connected
-- instance self-corrects; this is for one that cannot reach the catalog host.
-- Derived from each row's own input price rather than baked as absolute figures,
-- so a later price move stays consistent. OpenAI reads cached input at 0.1x and
-- charges no cache-write premium.
--
-- An agent run is cache-read dominated - 96% of input tokens on the instance this
-- came from - so the previous NULL fallback, which bills cache traffic at the full
-- input rate, overstated those runs by roughly tenfold.
--
-- Enumerated rather than matched with LIKE 'gpt-%': deriveModelId strips the
-- author prefix, so a third-party proxy's row could carry a matching name while
-- pricing nothing of OpenAI's. Only feed rows are touched, and only where the
-- rates are still unset, so no operator override is disturbed.
UPDATE model_pricing
   SET cache_read_per_token     = input_per_token * 0.1,
       cache_creation_per_token = input_per_token,
       updated_at               = now()
 WHERE source = 'pricepertoken'
   AND cache_read_per_token IS NULL
   AND input_per_token > 0
   AND model_id IN (
     'codex-mini', 'gpt-3.5-turbo', 'gpt-3.5-turbo-16k', 'gpt-3.5-turbo-instruct',
     'gpt-4', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.5-0227', 'gpt-4o',
     'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5', 'gpt-5.1', 'gpt-5.1-chat',
     'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.2',
     'gpt-5.2-chat', 'gpt-5.2-codex', 'gpt-5.2-pro', 'gpt-5.3-chat',
     'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4-pro',
     'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.6-luna', 'gpt-5.6-luna-pro', 'gpt-5.6-sol',
     'gpt-5.6-sol-pro', 'gpt-5.6-terra', 'gpt-5.6-terra-pro', 'gpt-5-chat',
     'gpt-5-codex', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro', 'gpt-6-astra',
     'gpt-6-astra-pro', 'gpt-chat', 'o1', 'o1-mini', 'o1-pro', 'o3',
     'o3-deep-research', 'o3-mini', 'o3-mini-high', 'o3-pro', 'o4-mini',
     'o4-mini-deep-research', 'o4-mini-high'
   );
