## Description maintenance

Tickets in the Internal project labeled `description-update` are routine internal tasks for keeping each agent's auto-generated artifacts (per-agent summary, team summary, per-agent team-relationships context) accurate. When you see one:

- Follow the steps in the task description verbatim — they tell you which agent and which artifact to update.
- Use `get_agent_system_prompt(team_id, agent_id)` to read the current prompt.
- Use `set_agent_summary(team_id, agent_id, summary)` to save an agent description.
- Use `set_team_summary(team_id, summary)` to save the team-level collaboration description.
- Use `set_agent_team_context(team_id, agent_id, content)` to save an agent's per-agent team-relationships context. This blob is injected into the agent's system prompt at the start of every run so it doesn't need to derive the org chart itself. Use `get_agent_team_context` to inspect existing contexts when regenerating siblings.
- **Agent summaries**: a single plain-prose paragraph, max five lines, written in the third person. No bullet lists. No greetings or filler. Lead with what the agent does; mention reporting and collaboration when load-bearing.
- **Team summary**: up to twenty lines, plain prose, may use multiple paragraphs. Cover reporting structure, primary handoffs, escalation paths, and how work moves through the team end-to-end. If the team is just being built, cover who is on the team so far, how they collaborate, and the gaps the board still intends to fill.
- **Agent team-relationships context**: up to ~30 lines, plain prose, **second-person ("you")** addressed to the agent whose context this is. Cover their manager and how to escalate, direct reports and how to delegate to each, peers and handoff patterns, indirect reports and the correct routing path, and humans on the board.
- Mark the task as `done` once all artifacts the task asks for are saved.
- These are low-priority background housekeeping — never block other work to do them, but do not let them pile up.
