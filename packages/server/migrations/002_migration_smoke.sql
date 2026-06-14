-- First incremental migration after the frozen 001 baseline (HID-188).
--
-- This is an intentionally harmless, idempotent placeholder whose only job is to
-- exercise the real upgrade path end-to-end: an instance created by an official
-- release (which has only 001 applied) gains a pending migration when upgraded to
-- a binary that ships this file, so the copy-migrate-swap runs and we can confirm
-- existing data is preserved. Replace this with a real schema change when one lands.
--
-- Idempotent: re-running the SQL is a no-op (the runner already applies each
-- migration exactly once, but additive/IF-NOT-EXISTS DDL keeps it safe regardless).

CREATE TABLE IF NOT EXISTS migration_smoke (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT migration_smoke_singleton CHECK (id = 1)
);

INSERT INTO migration_smoke (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
