-- Add Requesty to the `ai_provider` enum. Like OpenRouter it is a hosted router
-- reached through the existing `opencode` agent runtime, so `agent_runtime`
-- needs no change and no config row needs rewriting.
--
-- A purely additive enum extension, safe under the runner's per-migration
-- transaction because nothing in this file uses the new value.
ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'requesty';
