-- How many tools each MCP server contributed to a run, as reported by the
-- runtime's own session-init event and parsed in services/agent-stream-parser.ts.
-- Stored as a jsonb object keyed by server name: {"hezo": 82, "typefully": 25}.
--
-- NULL = not reported. That is the correct reading for every run predating this
-- migration, and for every runtime other than Claude Code, which is the only one
-- emitting an init event carrying a tool list. It is deliberately distinct from
-- a recorded zero: "we do not know" and "the server contributed nothing" lead an
-- agent to different conclusions, and only the second is actionable.
--
-- Read through list_connectors, so an agent that suspects a connector is broken
-- can check what its own run actually received instead of inferring it. A wrong
-- inference is what prompted this: an agent reported a connector toolless while
-- its card read Connected, and nothing in the system could confirm or refute it.
--
-- No index: the row is only ever reached by primary key, and the auth path
-- already selects it on every MCP request.
ALTER TABLE heartbeat_runs
  ADD COLUMN IF NOT EXISTS mcp_tool_counts jsonb DEFAULT NULL;
