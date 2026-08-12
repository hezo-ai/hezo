-- Gate a newly created agent's work on the team setup / coherence review that is
-- auto-created when the agent joins. The pointer is stamped once at agent
-- creation and read by createTask to attach a blocker edge while that review is
-- still open; it stops gating on its own once the review reaches a terminal
-- status, so nothing has to clear it.
--
-- Nullable with no backfill: every pre-existing agent is already established and
-- has been through (or predates) its review, so NULL is the correct value.
-- No index -- the only read is by member_agents.id (PK) joined to tasks.id (PK).

ALTER TABLE member_agents
    ADD COLUMN setup_review_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;
