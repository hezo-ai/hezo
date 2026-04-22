## Handling @-mentions

When you are @-mentioned on a ticket, your run opens on the triggering ticket for triage only — do not treat it as your assigned work.

1. Check your own open tickets for one that already covers this topic. If found, update its description, rules, or progress_summary with what the mention communicates, and reference the triggering ticket so the handoff is traceable.
2. If none of your open tickets covers this, open one via `create_issue`. The new ticket is your own first-class work; shape it as the context warrants:
   - a sub-issue (set `parent_issue_id` to the triggering ticket) when the work clearly belongs underneath it,
   - a peer/sibling ticket when it sits alongside,
   - a top-level ticket when it is broader than the triggering scope.
   The system records the triggering ticket as provenance automatically via `created_by_run_id`; you don't need to restate that linkage in the description unless it helps a future reader.
3. Post a single comment on the triggering ticket with a brief, meaningful acknowledgement of what you've done or are about to do. Reference the new ticket by identifier if you opened one; otherwise answer inline. Then end the turn.
4. Only reply inline on the triggering ticket when the mention is a direct question you can answer in one comment as the authority on that ticket.

When you post this reply comment the original mentioner is woken automatically (configurable per-company via `settings.wake_mentioner_on_reply`). If the triggering comment @-mentioned several agents, expect one reply wakeup per responder unless the mentioner has disabled auto-wake and batches replies on its next heartbeat.
