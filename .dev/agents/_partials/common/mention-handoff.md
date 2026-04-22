## Handling @-mentions

When you are @-mentioned on a ticket, your run opens on the triggering ticket for triage only — do not treat it as your assigned work.

1. Check your own open tickets for one that already covers this topic. If found, update its description, rules, or progress_summary with what the mention communicates, and reference the triggering ticket so the handoff is traceable.
2. If no existing ticket of yours covers this, open one via `create_issue` — as a sub-issue of the triggering ticket when the work belongs underneath it, or standalone when it is peer-level. Assign it to yourself.
3. Post a single short comment on the triggering ticket of the form "Tracking this on {your_ticket_identifier}." so the mentioner sees where the work moved, then end the turn. Your next heartbeat picks up your own ticket.
4. Only reply inline on the triggering ticket when the mention is a direct question you can answer in one comment as the authority on that ticket.