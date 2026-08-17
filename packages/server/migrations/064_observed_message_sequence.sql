-- A monotonic arrival order for the observed-message buffer.
--
-- The buffer keeps the newest N messages per chat and replays them oldest-first
-- as prompt context, both ordered by `created_at` alone. That column defaults to
-- the transaction clock, and a burst of messages lands inside one tick: measured
-- on the embedded backend, 60 consecutive records produced only 35 distinct
-- timestamps. Ordering on it is therefore not a total order, so the prune's
-- "keep the newest" picked arbitrarily among tied rows - it could delete a
-- message that arrived after one it kept - and the replayed context could hand
-- the agent a conversation out of order.
--
-- `id` cannot break the tie: it is a random UUID, which would make the choice
-- deterministic without making it right. Arrival order needs a counter.
--
-- Data-preserving: every existing row keeps its content and gets a `seq`
-- assigned in its current best-known order (`created_at`, then `id` so the
-- backfill itself is deterministic), and the sequence resumes above the highest
-- value so new rows sort after every old one.

ALTER TABLE chat_observed_messages ADD COLUMN seq BIGINT;

UPDATE chat_observed_messages m
   SET seq = o.rn
  FROM (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
      FROM chat_observed_messages
  ) o
 WHERE m.id = o.id;

CREATE SEQUENCE chat_observed_messages_seq_seq OWNED BY chat_observed_messages.seq;

SELECT setval(
  'chat_observed_messages_seq_seq',
  COALESCE((SELECT MAX(seq) FROM chat_observed_messages), 0) + 1,
  false
);

ALTER TABLE chat_observed_messages
  ALTER COLUMN seq SET DEFAULT nextval('chat_observed_messages_seq_seq');
ALTER TABLE chat_observed_messages ALTER COLUMN seq SET NOT NULL;

-- Serves both the per-chat read and the prune's keep-set, which are
-- filter-then-sort-then-limit on exactly these columns.
CREATE INDEX IF NOT EXISTS idx_observed_messages_chat_seq
    ON chat_observed_messages (channel, external_chat_id, seq DESC);
