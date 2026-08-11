-- Retire the Prime Agent runtime.
--
-- 054 added `prime_agent` to the `agent_runtime` enum and 0.42.0 shipped it, so
-- an upgrading instance can be holding rows that select it. The TS `AgentRuntime`
-- union no longer carries the value, and every per-runtime table in
-- `@hezo/shared` is an exhaustive `Record<AgentRuntime, …>` - so a surviving row
-- would resolve to `undefined` at the point a run is assembled (no command, no
-- arg tables, no MCP adapter) and fail with a type error rather than a message.
-- Re-point them here instead.
--
-- **The enum value itself stays.** Postgres cannot drop one, and the two ways
-- around that - recreating the type, or rewriting every column that uses it -
-- would take an exclusive lock on `tasks` and `chat_sessions` to delete a label
-- nothing can write any more: `runtime` and `runtime_type` are only ever set
-- from the TS enum, which no longer contains it. A dead label costs nothing; a
-- table rewrite on a live instance is not free.
--
-- Three places can hold it:
--
--   * `ai_provider_configs.runtime` - an operator's explicit CLI choice for a
--     provider. NULL means "this provider's default", which is what the picker
--     will offer now, so nulling is the honest restore: the credential keeps
--     working on the provider's default CLI rather than the config disappearing.
--   * `tasks.runtime_type` - a per-task pin, nullable, same reasoning.
--   * `chat_sessions.runtime_type` - NOT NULL, and a live session's row (the
--     table 001 created as `ceo_sessions`, renamed by 021). The
--     session is restartable and its runtime is re-resolved on restart, so
--     `claude_code` is the safe landing: it is the default for every provider
--     that could have reached Prime Agent (all eight had it as an *alternate*).
--
-- Guarded with `IS DISTINCT FROM` rather than a bare UPDATE: under MVCC a no-op
-- write still leaves a dead tuple, and the embedded backend has no autovacuum.

UPDATE ai_provider_configs
   SET runtime = NULL
 WHERE runtime IS DISTINCT FROM NULL
   AND runtime = 'prime_agent';

UPDATE tasks
   SET runtime_type = NULL
 WHERE runtime_type IS DISTINCT FROM NULL
   AND runtime_type = 'prime_agent';

UPDATE chat_sessions
   SET runtime_type = 'claude_code'
 WHERE runtime_type = 'prime_agent';
