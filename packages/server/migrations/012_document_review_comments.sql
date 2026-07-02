-- Review comments an admin leaves on a project document in view mode.
-- Version-scoped: any content change to the document (admin save, agent
-- write_project_doc, revision restore) deletes all of its review comments —
-- enforced in services/documents.ts, not by trigger, so the wipe shares the
-- same transaction and broadcast path as the edit itself.

CREATE TABLE document_review_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    -- Exact rendered-text snippet the comment anchors to.
    quote TEXT NOT NULL,
    -- Which occurrence of `quote` in the document's rendered text stream
    -- (0-based) the highlight targets, for duplicated snippets.
    occurrence INTEGER NOT NULL DEFAULT 0,
    comment TEXT NOT NULL,
    -- NULL means the admin (same convention as task_comments.author_member_id).
    author_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    -- documents.updated_at at authoring time; lets creates reject a stale view.
    doc_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_review_comments_document
    ON document_review_comments(document_id);

CREATE TRIGGER trg_document_review_comments_updated
    BEFORE UPDATE ON document_review_comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
