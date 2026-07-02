-- Agent-filed asset-deletion approval flow: agents cannot delete assets
-- directly; they post an `asset_deletion_request` comment that an admin
-- approves or denies, and the requesting agent is re-woken with the outcome
-- (`asset_deletion_resolved`).
--
-- Purely additive enum extensions. Postgres 12+ (PGlite is PG16) permits
-- ALTER TYPE ... ADD VALUE inside a transaction as long as the new value is
-- not *used* in the same transaction — this migration only adds them, so it is
-- safe under the runner's per-migration BEGIN/COMMIT (see 007 for precedent).
-- Existing rows keep their values; the new values simply become selectable.
ALTER TYPE comment_content_type ADD VALUE IF NOT EXISTS 'asset_deletion_request';
ALTER TYPE wakeup_source ADD VALUE IF NOT EXISTS 'asset_deletion_resolved';
