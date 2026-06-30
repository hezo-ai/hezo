-- Automatic, agent-driven chat memory.
--
-- Replaces the hand-maintained `chat-memory.md` HQ project doc with a per-agent
-- long-term memory store and a byte-bounded message window. The chat agent
-- compacts its own window into long-term memory; the server only marks evicted
-- messages. Data-preserving: existing chat-memory.md content is carried forward
-- into the new store keyed to the CEO member before the doc is removed.

-- Per-agent long-term memory: one markdown blob per member, no revision history.
-- Injected into every chat turn and surfaced on the agent's Chat history tab.
CREATE TABLE chat_memories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  UUID NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  content    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mark a chatbox message as compacted into long-term memory. NULL = still in the
-- active window (what the chatbox shows and the turn prompt replays). Set once
-- the agent has folded the message's content into its long-term memory.
ALTER TABLE ceo_messages ADD COLUMN compacted_at TIMESTAMPTZ;

-- The active-window query filters on compacted_at IS NULL ordered by recency.
CREATE INDEX idx_ceo_messages_active
  ON ceo_messages(conversation_id, created_at) WHERE compacted_at IS NULL;

-- Carry forward the existing chatbox memory: the HQ chat-memory.md content
-- becomes the CEO member's long-term memory. Keyed via the CEO agent's member so
-- it survives regardless of whether a conversation row exists yet.
INSERT INTO chat_memories (member_id, content, updated_at)
SELECT ma.id, d.content, d.updated_at
FROM member_agents ma
JOIN members m ON m.id = ma.id
JOIN projects p ON p.team_id = m.team_id AND p.is_internal = true
JOIN documents d ON d.project_id = p.id AND d.type = 'project_doc' AND d.slug = 'chat-memory.md'
WHERE ma.slug = 'ceo'
ON CONFLICT (member_id) DO NOTHING;

-- The chat-memory.md doc and the old message-count window setting are obsolete.
DELETE FROM documents WHERE type = 'project_doc' AND slug = 'chat-memory.md';
DELETE FROM system_meta WHERE key = 'chat_history_limit';
