-- Admit a fourth kind of system message to a chat thread: the turn is parked
-- until another execution finishes with the provider credential it needs, on a
-- subscription that runs one agent at a time. The row names that execution and
-- links to it when it is a task run - the chat twin of a waiting run's
-- `[runner] Waiting for ...` line.
--
-- `system_kind` is TEXT under a CHECK list rather than an enum, so the change is
-- a re-stated constraint: every existing row keeps its value, and an unknown
-- kind still fails loudly at the write.

ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_system_kind_check;

ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_system_kind_check
    CHECK (system_kind IS NULL OR system_kind IN ('converted_task', 'handoff_not_delivered', 'connector_refused', 'credential_wait'));
