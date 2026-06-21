-- 015_heartbeat_run_usage_partial.sql
-- Persist token usage incrementally during a run so it survives a crash.
--
-- Token usage was only written to heartbeat_runs at run completion, from the
-- in-memory stream parser. When the server restarted mid-run, that state was
-- lost and reconcileOnStartup marked the run failed with input_tokens /
-- output_tokens / cost_cents still at their DEFAULT 0 — so a 20-minute run
-- reported "0 in / 0 out tokens" and its spend never reached cost_entries or any
-- budget window.
--
-- The runner now flushes the running usage to the row alongside log_text (the
-- same ~500ms cadence that already keeps the log crash-safe), and reconcile
-- charges any surviving cost to the provider budget. This flag marks those
-- mid-run snapshots as partial (an approximate, not-yet-final total) so the UI
-- can label them; a clean completion clears it.

ALTER TABLE heartbeat_runs ADD COLUMN usage_partial BOOLEAN NOT NULL DEFAULT false;
