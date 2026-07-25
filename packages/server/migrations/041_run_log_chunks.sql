-- Append-only run-log chunk storage. The streaming log flusher used to rewrite
-- the ENTIRE accumulated `heartbeat_runs.log_text` blob every debounce tick;
-- under MVCC each rewrite left a full dead TOAST copy behind, so a
-- linearly-growing log wrote O(n²) bytes and bloated the database (~98% dead
-- space measured on busy instances). Logs now live in this child table as
-- ordered chunks: the flusher INSERTs only the text appended since the last
-- flush, and readers concatenate with `string_agg(content ORDER BY seq)`.
-- INSERT-only means no UPDATE-driven TOAST orphaning at all — O(n) bytes
-- written per run.
--
-- Data-preserving: every existing run's log is carried over as a single seq-0
-- chunk before the old column is dropped. The drop itself is metadata-only;
-- the legacy dead TOAST space is reclaimed by a one-time startup VACUUM (see
-- runLegacyRunLogVacuumOnce in src/db/run-log-chunks.ts).
CREATE TABLE heartbeat_run_log_chunks (
    run_id     UUID NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
);

INSERT INTO heartbeat_run_log_chunks (run_id, seq, content)
SELECT id, 0, log_text FROM heartbeat_runs WHERE log_text <> '';

ALTER TABLE heartbeat_runs DROP COLUMN log_text;
