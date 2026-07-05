-- Document status: a lightweight lifecycle flag on documents, settable by
-- humans (web UI) and agents (PATCH /docs/:filename, set_project_doc_status).
-- Surfaced only for project docs; team_preferences and agent_system_prompt
-- rows carry the default and never expose it. Existing rows backfill to
-- 'planning' via the column default — no data transform needed.
CREATE TYPE document_status AS ENUM ('planning', 'approved');

ALTER TABLE documents
    ADD COLUMN status document_status NOT NULL DEFAULT 'planning';
