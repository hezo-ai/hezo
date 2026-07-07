-- File attachments on realtime-chat messages. Mirrors `comment_attachments`
-- (task-comment attachments): a join row per (message, asset). Files uploaded
-- through the chatbox are stored in the HQ project's asset library under
-- `uploads/ceo-chat/`; this table links them to the message they were sent with
-- so the message re-renders its attachments as chips and the agent can open them.
--
-- Purely additive — no existing rows to carry forward. Cascades on both sides so
-- deleting a message or its asset cleans up the link.
CREATE TABLE chat_message_attachments (
    chat_message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    asset_id        UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_message_id, asset_id)
);

CREATE INDEX idx_chat_message_attachments_message ON chat_message_attachments(chat_message_id);
