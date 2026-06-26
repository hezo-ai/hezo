-- Per-secret opt-in allowing the egress proxy to substitute this secret's
-- placeholder into small JSON request bodies (e.g. an API login that takes
-- credentials in the body and returns a token). Defaults to false: existing
-- secrets keep header/URL-only substitution until a human explicitly enables
-- body substitution (via the credential fulfillment form or the Credentials
-- settings UI).
ALTER TABLE secrets ADD COLUMN allow_body_substitution BOOLEAN NOT NULL DEFAULT false;
