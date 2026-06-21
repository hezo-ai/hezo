-- Embed task comments for semantic search.
-- Mirrors the tasks/documents/skills embedding columns from 001 (the `vector`
-- extension and the HNSW cosine index pattern). Only `text` comments are
-- embedded by the backfill cron; the column stays NULL for everything else.

ALTER TABLE task_comments ADD COLUMN embedding vector(384);

CREATE INDEX idx_comments_embedding ON task_comments USING hnsw (embedding vector_cosine_ops);
