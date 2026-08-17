-- Index for the agent executions list, which serves one page per view.
--
-- `heartbeat_runs (member_id, COALESCE(started_at, created_at) DESC, id DESC)`
--    The list is filter-then-sort-then-limit on exactly this: `WHERE member_id
--    = $1 ORDER BY COALESCE(started_at, created_at) DESC, id DESC` with an
--    offset page.
--
--    It sorts on the coalesced clock because that is the one each row renders,
--    and because ordering on started_at alone was wrong rather than merely
--    unindexed: a run that ended before it ever went running has no started_at,
--    and DESC means NULLS FIRST, so every such run sorted above every started
--    one for good. On an instance that had accumulated failures the first page
--    was entirely old ones and recent successes were unreachable behind them.
--
--    No existing index serves the new ordering. `idx_runs_member_started`
--    (member_id, started_at DESC) from 047 was built for this list's previous
--    shape and still serves the per-agent latest-run lateral, so it stays; an
--    expression is opaque to it either way. Without this the query falls back to
--    reading every run the agent has ever done and sorting it to render one
--    page of fifty, and `heartbeat_runs` is never pruned, so that degrades with
--    the instance's whole history rather than with anything bounded.
--
-- Additive. No row is read, moved or dropped, and the indexes beside it stay.

CREATE INDEX IF NOT EXISTS idx_runs_member_clock
    ON heartbeat_runs (member_id, (COALESCE(started_at, created_at)) DESC, id DESC);
