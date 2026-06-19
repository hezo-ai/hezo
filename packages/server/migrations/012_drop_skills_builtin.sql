-- Drop the built-in flag from skills.
--
-- The only built-in skill (`find-skills`) has been removed; its discovery and
-- authoring workflow now lives in the runtime-shared system-prompt instructions
-- rather than as a seeded catalog row. With no skill ever marked built-in, the
-- column and its delete-guard / UI-label machinery are dead. Reverses 009.
ALTER TABLE skills DROP COLUMN is_builtin;
