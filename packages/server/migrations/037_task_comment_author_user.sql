-- Attribute a task comment to the human user who authored it, so their uploaded
-- avatar (user_icons) can render beside their comments in the thread. Agent
-- authors are already attributed via author_member_id and API-key authors via
-- author_api_key_id, but a human admin stored neither (author_member_id was left
-- NULL by convention), leaving their comment un-linkable to a user — and so to
-- their avatar, which is why an admin's uploaded avatar never showed in comments.
-- This adds the missing human linkage; the comment queries join user_icons on it.
ALTER TABLE task_comments
    ADD COLUMN author_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill existing human-authored text comments to the sole superuser, but only
-- when exactly one exists (the single-admin instance — every instance today), so
-- the attribution is unambiguous and their historical comments pick up the avatar
-- too. With zero or multiple superusers the backfill is skipped and those rows
-- fall back to initials. The predicate targets only human admin text comments:
-- system comments are non-text, and agent/API-key comments carry an author id.
UPDATE task_comments
SET author_user_id = (SELECT id FROM users WHERE is_superuser = true)
WHERE content_type = 'text'
  AND author_member_id IS NULL
  AND author_api_key_id IS NULL
  AND (SELECT count(*) FROM users WHERE is_superuser = true) = 1;

-- Mirrors idx_comments_author / idx_comments_author_api_key: a partial index over
-- the non-null rows so the ON DELETE SET NULL FK maintenance on user removal is an
-- index scan rather than a seq scan over the whole comments table.
CREATE INDEX idx_comments_author_user ON task_comments(author_user_id)
    WHERE author_user_id IS NOT NULL;
