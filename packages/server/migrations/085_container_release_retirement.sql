-- Retire a container shortly after its run releases it, and meter every
-- container for the whole time the backend bills it.
--
-- 1. Which member a chat is keeping warm.
--
-- A container now waits only a few seconds after release for the next job in
-- its project, and a chat keeps exactly one member warm for a short pause after
-- its last turn. The pause is measured from the moment the chat turn released
-- that member, which nothing recorded: `last_released_at` is written by every
-- release, chat or task, and `chat_sessions.last_activity_at` is stamped when a
-- turn starts, so a long reply used up the pause before the person had read it.
--
-- NULL on every existing row, which reads as "no chat released this member" -
-- the honest answer for a member nothing has marked, and it costs at most one
-- chat pause of warmth on the first turn after the upgrade.
ALTER TABLE container_pool_members
    ADD COLUMN IF NOT EXISTS chat_released_at TIMESTAMPTZ;

-- Serves the per-project "newest chat release" lookup the retirement passes run
-- on every release and every sweep. Partial, because only members a chat
-- released carry a stamp, and a task release clears it.
CREATE INDEX IF NOT EXISTS idx_container_pool_members_chat_release
    ON container_pool_members (project_id, chat_released_at DESC)
    WHERE chat_released_at IS NOT NULL;

-- 2. Starting a container's interval where its previous one ended.
--
-- An interval now opens at the moment the start or create request is sent, and
-- the previous one closes only once the backend has finished stopping. A resume
-- asked for while that stop was still completing would otherwise begin before
-- the last interval ended and bill the overlap twice, so every open reads the
-- container's latest end first. One lookup per open, on a table that only grows.
CREATE INDEX IF NOT EXISTS idx_container_uptime_container_end
    ON container_uptime_entries (container_id, ended_at DESC);
