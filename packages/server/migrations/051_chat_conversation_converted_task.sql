-- Conversation-to-task conversion: a converted chat conversation records the
-- task it became. Converted threads stay listed in the web chatbox (the listing
-- predicate is "open OR converted") as a read-only record ending in a meta
-- message that links the task. ON DELETE SET NULL demotes the thread to an
-- ordinary closed thread when the task is deleted -- which also drops it from
-- the switcher, doubling as the operator's cleanup path.
ALTER TABLE chat_conversations
  ADD COLUMN converted_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;
