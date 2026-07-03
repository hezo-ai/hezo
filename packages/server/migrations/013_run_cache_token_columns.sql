-- Per-run cache token buckets. `input_tokens` remains the all-buckets display
-- aggregate; these record the cache-read / cache-write (creation) subsets so a
-- run's table-priced cost can be audited and recomputed. Rows that predate
-- this migration keep 0 = "split not recorded".
ALTER TABLE heartbeat_runs
    ADD COLUMN cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN cache_creation_tokens BIGINT NOT NULL DEFAULT 0;
