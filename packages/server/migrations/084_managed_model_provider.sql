-- Add the managed provider (`hezo_cloud`) to the `ai_provider` enum: the model a
-- hosting control plane provides, written as a credential row from the hosted
-- config on every boot and removed with that config. It runs on the existing
-- `claude_code` runtime, so `agent_runtime` needs no change, and its endpoint and
-- request headers ride in `ai_provider_configs.metadata`, which is already jsonb.
--
-- Purely additive. The value is only added here, never used, so it is safe
-- inside the runner's per-migration transaction. Every column typed by the enum
-- keeps its rows as they are.
ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'hezo_cloud';
