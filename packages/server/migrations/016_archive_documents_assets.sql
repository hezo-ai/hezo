-- Archival (soft delete) for project docs and assets: agents archive via MCP
-- instead of deleting; hard deletion stays a human/admin-only UI action. An
-- archived row keeps its slot (docs keep their slug, assets keep their
-- project-unique filename) so existing `assets/<path>` and doc references
-- still resolve — archived items are merely hidden from default listings,
-- search, autocomplete, and agent-run context.
--
-- Purely additive: existing rows backfill to NULL (= active), so nothing
-- changes for current data. `archived_by_member_id` records who archived
-- (human admin or agent member) for the "Archived by X" banner; it nulls out
-- if that member is ever removed, exactly like last_updated_by_member_id.
ALTER TABLE documents
    ADD COLUMN archived_at TIMESTAMPTZ,
    ADD COLUMN archived_by_member_id UUID REFERENCES members(id) ON DELETE SET NULL;

ALTER TABLE assets
    ADD COLUMN archived_at TIMESTAMPTZ,
    ADD COLUMN archived_by_member_id UUID REFERENCES members(id) ON DELETE SET NULL;
