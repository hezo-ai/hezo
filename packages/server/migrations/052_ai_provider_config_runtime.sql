-- Let a credential choose which CLI runs it.
--
-- Until now the agent runtime was implied by the provider: `PROVIDER_TO_RUNTIME`
-- mapped each `ai_provider` to exactly one `agent_runtime`, and there was nowhere
-- to record a different choice. That is why the Moonshot models ship as two
-- providers (`kimi` on Claude Code, `kimi_code` on Moonshot's own CLI) despite
-- being the same upstream reached with the same key — the provider column was
-- doing double duty as a runtime column.
--
-- This adds the missing axis. `runtime` is the CLI the operator picked for THIS
-- credential; NULL means "whatever the provider defaults to", which is the
-- behaviour every existing row already has. So this migration is purely
-- additive: no existing row is rewritten, no default is backfilled, and an
-- instance that never touches the new picker behaves identically before and
-- after. Deliberately NOT backfilled with each provider's current default — a
-- NULL keeps following the default if that default is ever changed in code,
-- whereas a materialised value would silently pin every existing credential to
-- today's choice.
--
-- Not enforced in SQL: which (provider, runtime) pairings are actually valid.
-- That table lives in TypeScript (`providerSupportsRuntime`), is validated at
-- the write routes, and changes when a provider gains a CLI — encoding it as a
-- CHECK constraint would mean a migration every time that roster moved, and
-- would turn a stale pairing into an un-writable row rather than a clear 400.
ALTER TABLE ai_provider_configs
    ADD COLUMN IF NOT EXISTS runtime agent_runtime;

COMMENT ON COLUMN ai_provider_configs.runtime IS
    'CLI runtime chosen for this credential. NULL = the provider default (PROVIDER_TO_RUNTIME).';
