-- 007_comment_public_id.sql
-- Give every task comment a human-friendly, URL-safe public identifier derived
-- from its creation time (UTC, `YYYYMMDDHH24MISS`), e.g. `20261009112345`.
-- Comment deep-links and `<TASK-ID>#comment-<public_id>` mention links use this
-- slug instead of the opaque UUID primary key, so a link reads
-- `TO-4#comment-20261009112345` instead of `TO-4#comment-15596d5f-debc-4fb6-...`.
--
-- The UUID `id` stays the primary key and the target of every foreign key
-- (parent_comment_id, comment_reactions, tool_calls, comment_attachments,
-- admin_mentions); `public_id` is a per-task display slug only. This mirrors the
-- project-wide convention: browser URLs use slugs, internal ids stay UUIDs.

ALTER TABLE task_comments ADD COLUMN public_id TEXT;

-- Backfill existing rows. Within a single task multiple comments can land in the
-- same one-second window (agent bursts, auto-generated system comments), so
-- disambiguate collisions with a `-N` suffix ordered by creation time then id:
-- the first comment in a second keeps the bare timestamp, later ones get
-- `-2`, `-3`, ... The timestamp is computed in UTC so the slug is stable
-- regardless of the server's session time zone.
WITH numbered AS (
    SELECT
        id,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') AS base,
        row_number() OVER (
            PARTITION BY task_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS')
            ORDER BY created_at, id
        ) AS rn
    FROM task_comments
)
UPDATE task_comments tc
SET public_id = CASE WHEN n.rn = 1 THEN n.base ELSE n.base || '-' || n.rn END
FROM numbered n
WHERE n.id = tc.id;

ALTER TABLE task_comments ALTER COLUMN public_id SET NOT NULL;

-- A `<TASK-ID>#comment-<public_id>` link is addressed by (task, public_id), so
-- the slug only needs to be unique within its task.
CREATE UNIQUE INDEX idx_comments_public_id ON task_comments(task_id, public_id);

-- Auto-assign public_id on insert for every code path (routes, MCP tools,
-- services, system comments) so no insert site has to know the scheme. A
-- BEFORE INSERT trigger fires after column defaults are applied, so
-- NEW.created_at is already populated. The WHILE loop sees rows inserted earlier
-- in the same transaction, so back-to-back system comments disambiguate
-- correctly; the unique index above is the backstop.
CREATE OR REPLACE FUNCTION set_task_comment_public_id()
RETURNS TRIGGER AS $$
DECLARE
    v_base      TEXT;
    v_candidate TEXT;
    v_n         INTEGER := 1;
BEGIN
    IF NEW.public_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    v_base := to_char(COALESCE(NEW.created_at, now()) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS');
    v_candidate := v_base;
    WHILE EXISTS (
        SELECT 1 FROM task_comments
        WHERE task_id = NEW.task_id AND public_id = v_candidate
    ) LOOP
        v_n := v_n + 1;
        v_candidate := v_base || '-' || v_n;
    END LOOP;
    NEW.public_id := v_candidate;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_task_comments_public_id
    BEFORE INSERT ON task_comments
    FOR EACH ROW EXECUTE FUNCTION set_task_comment_public_id();
