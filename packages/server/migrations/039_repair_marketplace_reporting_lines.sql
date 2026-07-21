--------------------------------------------------------------------------------
-- REPAIR MARKETPLACE REPORTING LINES
--------------------------------------------------------------------------------
-- A provisioning bug dropped the Captain-facing reporting lines of marketplace
-- team rosters: the Captain is provisioned as a builtin *outside* the roster
-- array, and the roster wiring pass only resolved `reports_to_slug` against the
-- roster itself — so every manifest entry saying `reports_to_slug: "captain"`
-- silently resolved to nothing and the agent was left reporting to no one
-- (rendered directly under the admin in the org chart). Intra-roster lines
-- (e.g. engineer → architect) were unaffected.
--
-- Repair scope is deliberately narrow. A row is only touched when it:
--   * is an inline marketplace-provisioned agent (agent_type_id IS NULL),
--   * currently reports to no one (reports_to IS NULL — a line an admin has
--     since set by hand is never overwritten),
--   * carries a slug that a shipped marketplace team manifest points at the
--     Captain, and
--   * shares a team with a 'captain' agent.

WITH captain_reports(slug) AS (
    VALUES
        -- software-development
        ('architect'), ('product-lead'), ('marketing-lead'), ('researcher'),
        -- influencer
        ('brand-strategist'), ('trend-researcher'), ('distribution-manager'),
        -- investment
        ('market-researcher'), ('equity-analyst'), ('catalyst-monitor'),
        ('risk-verifier'), ('report-writer')
)
UPDATE member_agents ma
SET reports_to = cap.id
FROM members mem,
     captain_reports cr,
     member_agents cap
     JOIN members capm ON capm.id = cap.id
WHERE mem.id = ma.id
  AND ma.agent_type_id IS NULL
  AND ma.reports_to IS NULL
  AND ma.slug = cr.slug
  AND cap.slug = 'captain'
  AND capm.team_id = mem.team_id;
