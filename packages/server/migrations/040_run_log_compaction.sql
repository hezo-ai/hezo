-- Agent run-log compaction. The dominant consumer of database size is
-- `heartbeat_runs.log_text` — one verbose per-run blob (capped at ~10 MB each),
-- kept forever. Compaction trims old runs' logs down to their meaningful tail
-- (the agent's end-of-run summary + the trailing `[done] … tokens=… cost=…`
-- line) and stamps this column so a trimmed run is never re-scanned.
--
-- `log_compacted_at` NULL = the full log is still intact; a timestamp = the log
-- has been compacted (at that time). Mirrors the `compacted_at TIMESTAMPTZ`
-- marker `008_chat_memory_compaction.sql` added to `ceo_messages`.
--
-- Purely additive: existing rows backfill to NULL (not yet compacted), so no
-- current data changes. The partial index keeps the oldest-first "which runs
-- still need compacting" scan cheap and shrinks as rows are compacted.
ALTER TABLE heartbeat_runs ADD COLUMN log_compacted_at TIMESTAMPTZ;

CREATE INDEX idx_runs_compaction ON heartbeat_runs (created_at) WHERE log_compacted_at IS NULL;
