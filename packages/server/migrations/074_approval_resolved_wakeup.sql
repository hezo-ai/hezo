-- The admin resolving a proposal an agent filed is that agent being answered,
-- not the system pinging it. Two changes behind that one fact; siblings from one
-- change set, so they share a file rather than stacking numbers.
--
-- Both are additive. No row is dropped or rewritten except the one-off backfill
-- in part 2, which only fills a column that did not exist a statement earlier.

-------------------------------------------------------------------------------
-- 1. A wakeup source for "the admin decided on your proposal"
-------------------------------------------------------------------------------
--
-- Hire and goal-suggestion resolutions woke the requester on the generic
-- `automation` source, which the dispatch suppressions in
-- `services/no-work-backoff.ts` are entitled to discard - and did, silently,
-- leaving an approved hire with nobody to act on it until the requester's next
-- scheduled heartbeat (12 hours at the default cadence). `automation` also
-- carries genuine housekeeping (container start, the Coach's task-done ping)
-- that must stay suppressible, so the answer is a source of its own, exempt the
-- way `credential_provided` and `asset_deletion_resolved` already are.
--
-- Postgres 12+ (PGlite is PG16) permits ALTER TYPE ... ADD VALUE inside a
-- transaction as long as the new value is not *used* in the same transaction.
-- Nothing below uses it, so this is safe under the runner's per-migration
-- BEGIN/COMMIT (see 011 for precedent).
ALTER TYPE wakeup_source ADD VALUE IF NOT EXISTS 'approval_resolved';

-------------------------------------------------------------------------------
-- 2. When a choice card was answered
-------------------------------------------------------------------------------
--
-- Both dispatch suppressions ask "has anything landed on this task since?" and
-- answer it by looking for a task_comments row created after the last run.
-- Answering a choice card writes no row - it sets `chosen_option` on the card
-- already there - so the one event that most obviously ends a wait was the one
-- event neither suppression could see.
--
-- A column plus a trigger rather than an edit at each of the six writers of
-- `chosen_option`: a seventh added later is covered without anyone remembering,
-- and `chosen_option->>'resolved_at'` is not an option because only some writers
-- set it. `task_comments` has no `updated_at` to borrow.
ALTER TABLE task_comments ADD COLUMN chosen_at TIMESTAMPTZ;

-- Existing resolved cards keep an honest timestamp: the resolver's own
-- `resolved_at` where one was recorded, else the comment's creation time. Both
-- are in the past, so no backfilled row can look newer than a run that has
-- already finished.
UPDATE task_comments
SET chosen_at = COALESCE(NULLIF(chosen_option->>'resolved_at', '')::timestamptz, created_at)
WHERE chosen_option IS NOT NULL;

-- Stamped only on the NULL -> non-NULL transition, so re-writing a resolved
-- card's `content` (the display snapshot refresh both resolvers do) does not
-- move the answer's timestamp, and a row that arrives already resolved is
-- stamped on INSERT.
CREATE OR REPLACE FUNCTION set_task_comment_chosen_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.chosen_option IS NOT NULL
       AND (TG_OP = 'INSERT' OR OLD.chosen_option IS NULL)
       AND NEW.chosen_at IS NULL THEN
        NEW.chosen_at := now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_task_comments_chosen_at
    BEFORE INSERT OR UPDATE ON task_comments
    FOR EACH ROW EXECUTE FUNCTION set_task_comment_chosen_at();

-- The no-work backoff probes "was a card on this task answered after the last
-- run finished" once per dispatch. Partial, because a task's answered cards are
-- a small minority of its comments.
CREATE INDEX idx_comments_task_chosen_at
    ON task_comments(task_id, chosen_at) WHERE chosen_at IS NOT NULL;
