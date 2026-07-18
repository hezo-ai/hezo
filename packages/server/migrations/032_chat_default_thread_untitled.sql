-- The default web chat thread used to be created with a hardcoded title of 'Main'.
-- Threads now start untitled (NULL) and are auto-titled by the CEO from their
-- content, with the frontend rendering an untitled thread as the "New thread"
-- placeholder. Clear the legacy 'Main' title so existing default threads become
-- untitled too and get picked up by auto-titling like any freshly created thread.
--
-- Safe: 'Main' was only ever the hardcoded system default — there has never been a
-- UI (or MCP tool) to name a conversation, so no user-authored 'Main' title exists.
UPDATE chat_conversations SET title = NULL WHERE title = 'Main';
