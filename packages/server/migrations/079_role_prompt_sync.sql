-- Carrying a role doc's improvements into agents hired before it changed.
--
-- The boot seed keeps `agent_types.system_prompt_template` current from this
-- repo's role docs, but an agent's live prompt is a document copied out of that
-- template once, at hire time, and never refreshed - because the agent's learned
-- rules and the admin's edits accumulate there. So every role-doc improvement has
-- reached new instances and no existing one, and hardest of all the CEO and Coach,
-- which are hired on an instance's first boot and never hired again.
--
-- The new approval type is how the improved text is offered. Nothing rewrites a
-- prompt without a person accepting: that document belongs to the admin and the
-- agent, not to the release.
--
-- Separate from 078 rather than folded into it: that migration is the Coach's
-- retrospective, and its data-preservation test asserts that shape. Both ship in
-- the same change, but a reader opening either should find one subject.
--
-- ADD VALUE cannot be used by a later statement in the same transaction, and the
-- runner wraps each file in one - so nothing below may name this value.
ALTER TYPE approval_type ADD VALUE IF NOT EXISTS 'role_update';

-- The detector asks, per built-in agent, whether a decision is already standing
-- or was already declined - both keyed on the member id inside the payload, which
-- `idx_approvals_status(team_id, status)` cannot answer because the scan crosses
-- every team. Left unindexed it reads the whole approvals table once per agent on
-- every boot.
CREATE INDEX IF NOT EXISTS idx_approvals_type_status_member
    ON approvals (type, status, (payload->>'member_id'));
