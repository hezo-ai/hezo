-- Generalize document review comments to also target assets.
--
-- The table becomes `review_comments` with exactly one target per row:
-- a document (the original shape — quote + doc_updated_at required) or an
-- asset. Asset comments are version-scoped like doc comments, but their
-- stale token is `assets.sha256` (assets carry no updated_at), and their
-- wipe fires on any overwrite: `upsertProjectAsset` swaps the row's id on
-- every rewrite, so the wipe runs inside that transaction (lib/asset-name.ts)
-- and hard deletes cascade via the FK.
--
-- Text assets (markdown, text/plain) anchor with quote/occurrence exactly
-- like documents; non-text assets carry un-anchored whole-asset comments
-- (quote IS NULL). Which of the two a content type allows needs
-- `assets.content_type`, so it is enforced in the route, not by CHECK.

ALTER TABLE document_review_comments RENAME TO review_comments;
ALTER INDEX idx_document_review_comments_document RENAME TO idx_review_comments_document;
ALTER TRIGGER trg_document_review_comments_updated ON review_comments
    RENAME TO trg_review_comments_updated;

ALTER TABLE review_comments
    ALTER COLUMN document_id DROP NOT NULL,
    ALTER COLUMN quote DROP NOT NULL,
    ALTER COLUMN doc_updated_at DROP NOT NULL,
    ADD COLUMN asset_id UUID REFERENCES assets(id) ON DELETE CASCADE,
    -- assets.sha256 at authoring time; the asset-side stale guard.
    ADD COLUMN asset_sha256 TEXT;

-- Exactly one target.
ALTER TABLE review_comments ADD CONSTRAINT review_comments_one_target
    CHECK ((document_id IS NOT NULL)::int + (asset_id IS NOT NULL)::int = 1);
-- Doc comments keep their original shape: quote + version stamp required.
ALTER TABLE review_comments ADD CONSTRAINT review_comments_doc_shape
    CHECK (document_id IS NULL OR (quote IS NOT NULL AND doc_updated_at IS NOT NULL));
-- Asset comments always carry the sha stamp; doc comments never do.
ALTER TABLE review_comments ADD CONSTRAINT review_comments_asset_stamp
    CHECK ((asset_id IS NULL) = (asset_sha256 IS NULL));

CREATE INDEX idx_review_comments_asset ON review_comments(asset_id);
