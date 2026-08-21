-- Revision history for per-agent long-term chat memory.
--
-- `chat_memories.content` is the one memory surface in Hezo with no history at
-- all: `upsertChatMemory` overwrites it wholesale, and it is injected in full
-- into every chat turn. Every other versioned surface (project docs, the project
-- Custom Prompt, agent system prompts, skills) already keeps revisions and can be
-- restored from the web app; this one could not be recovered after a bad write.
--
-- That matters more here than anywhere else because the write is *automatic*: when
-- the live message window exceeds its byte cap the agent compacts the entire
-- window into this field in one rewrite. A compaction that over-summarises
-- silently destroys standing operator preferences with nothing to roll back to.
--
-- Mirrors `document_revisions`: one row per content-changing write holding the
-- PRIOR content, so the newest row is what the current value replaced. A create
-- records no revision, exactly as `upsertDocument` behaves.
CREATE TABLE chat_memory_revisions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id         UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    revision_number   INTEGER NOT NULL,
    content           TEXT NOT NULL,
    change_summary    TEXT NOT NULL DEFAULT '',
    -- Who caused the write. NULL is the automatic compaction the agent performs on
    -- its own memory; a member id is an operator edit or restore from the web app.
    -- The distinction is the useful half of this history: an operator reading it
    -- needs to tell "I corrected this" from "a compaction rewrote it".
    author_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (member_id, revision_number)
);

-- The history read is always "this member's revisions, newest first".
CREATE INDEX idx_chat_memory_revisions_member
    ON chat_memory_revisions(member_id, revision_number DESC);

-- Purely additive: existing `chat_memories` rows keep their content untouched and
-- simply have no revisions yet, which reads correctly as "never edited since this
-- release". Nothing is backfilled because the prior contents were never recorded —
-- inventing a revision would claim a history that does not exist.
