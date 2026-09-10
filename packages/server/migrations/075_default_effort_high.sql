-- Raise the column default for agent effort from 'medium' to 'high'.
--
-- The global fallback (`DEFAULT_EFFORT` in @hezo/shared) and these two column
-- defaults are the same fact in two places; the constant moves in this same
-- commit.
--
-- Load-bearing rather than cosmetic. Every other insert into these tables names
-- the column, but `POST /api/agent-types` (routes/agent-types.ts) omits it, and
-- team-template-provision then copies an agent type's effort onto every agent
-- provisioned from that type.
--
-- DEFAULT only, no UPDATE. Existing rows keep whatever they hold: an operator
-- who chose 'medium' for an agent chose it, and rewriting that would raise the
-- agent's spend without asking. SET DEFAULT is a catalog-only change - no table
-- rewrite, no row touched.
--
-- 'high' is an existing member of `agent_effort` (created in 001), so this does
-- not run into the "ALTER TYPE ... ADD VALUE cannot be used in the same
-- transaction" limit the runner's per-migration transaction imposes.

ALTER TABLE agent_types ALTER COLUMN default_effort SET DEFAULT 'high'::agent_effort;
ALTER TABLE member_agents ALTER COLUMN default_effort SET DEFAULT 'high'::agent_effort;
