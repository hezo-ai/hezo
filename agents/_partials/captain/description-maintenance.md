## Team coherence review

Tickets in the Internal project labeled `team-coherence-review` are how you keep the team coherent after roster or prompt changes. One ticket per change covers everything: org-chart audit AND the descriptive blobs other agents read.

When you see one:

- Follow the steps in the task description verbatim.
- Use `list_agents(team_id)` to enumerate the current roster and `get_agent_system_prompt(team_id, agent_id)` to read prompts.
- Audit for orphans, cycles, stale prompts, coverage gaps, and conflicts. Reconcile what you can via `update_agent_system_prompt(agent_id, content)`. For changes that need board sign-off (re-parenting, removing an agent, hiring a new role), post one summary comment on the ticket and continue — don't block on the comment.
- Then rewrite the three descriptive blobs for every affected agent:
  - `set_agent_summary(team_id, agent_id, summary)` — single plain-prose paragraph, max five lines, third person, no bullets, no greetings. Leads with what the agent does.
  - `set_agent_team_context(team_id, agent_id, content)` — up to ~30 lines, plain prose, **second-person ("you")** addressed to the agent whose context this is. Covers manager and how to escalate, direct reports and how to delegate to each, peers and handoff patterns, indirect reports and the correct routing path, and humans on the board. This blob is injected into the agent's own system prompt at the start of every run.
  - `set_team_summary(team_id, summary)` — up to twenty lines, plain prose, may span paragraphs. Covers reporting structure, handoffs, escalation paths, and how work moves through the team end-to-end. While the team is still being built, cover who's there so far, how they collaborate, and the gaps the board still intends to fill.
- Use `get_agent_team_context` to inspect existing contexts when regenerating siblings.
- Mark the task as `done` once the audit and rewrites are complete.
- These are high-priority because every other agent's system prompt depends on them being accurate — but multiple change events while one ticket is open are coalesced into the same ticket, so you only do the work once.
