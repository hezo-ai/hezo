-- Project icons: an optional user-uploaded image that represents a project in
-- the rail (in place of the initials fallback). Stored as bytes in the database
-- per product requirement, in a dedicated 1:1 table so the hot `projects.*`
-- SELECT that powers the rail and the project list never pulls the image blob.

CREATE TABLE project_icons (
    project_id   UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    data         BYTEA NOT NULL,
    byte_size    INTEGER NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
