-- Index the "is this task waiting on the admin?" probe.
--
-- The task list now orders in three tiers - a run in flight, then a task parked
-- on the admin, then the rest - and the second tier asks, per row, whether the
-- task carries an ask comment nobody has answered yet. Without an index that
-- probe walks every comment on the task through idx_comments_task_created
-- (task_id, created_at); a task with a long thread pays for its whole history on
-- every page of every task list.
--
-- Partial, so the index holds only unanswered asks: a resolved one leaves the
-- index on the next write, and the whole structure stays proportional to the
-- open backlog rather than to the comment table. `connect_required` is absent
-- deliberately - it never sets chosen_option (a connector's resolved state lives
-- on its oauth_status), so it is not answerable this way.
--
-- The WHERE clause must stay verbatim-identical to the predicate in
-- adminActionPendingSql (packages/server/src/lib/task-sort.ts), which spells the
-- content types as literals for exactly this reason: the planner can only use a
-- partial index when it can prove the query implies the index predicate.
--
-- Index-only. No rows are read, written or moved.
CREATE INDEX idx_comments_pending_ask
    ON task_comments (task_id)
    WHERE chosen_option IS NULL
      AND content_type IN (
        'action'::comment_content_type,
        'credential_request'::comment_content_type,
        'asset_deletion_request'::comment_content_type
      );
