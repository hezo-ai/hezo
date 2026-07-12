-- Broker-managed OAuth connections (device-flow BYO on an `api` connector) may
-- carry a confidential client whose secret is required on the host-side refresh
-- grant (Google's "TVs and Limited Input devices" client). The client secret is
-- host-only refresh material: it lives in the `secrets` vault with empty
-- allowed_hosts (never egress-substitutable, never surfaced to a run — AGENTS.md
-- red line) and is referenced by name here. Nullable: only broker connections
-- with a confidential client populate it; GitHub / public clients leave it NULL.
ALTER TABLE oauth_connections
  ADD COLUMN client_secret_secret_id UUID REFERENCES secrets(id) ON DELETE SET NULL;
