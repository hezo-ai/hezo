## Handling @-mentions

When you are @-mentioned on a ticket, your run opens on the triggering ticket for triage only — do not treat it as your assigned work.

1. Check your own open tickets for one that already covers this topic. If found, use `update_issue` to fold what the mention communicates into the field that actually fits each piece of it: scope / domain context / what the ticket is about → `description`; in-flight status or what's been done → `progress_summary`; approach constraints or guardrails that shape how the work is done → `rules` (rules are for *how* the ticket should be worked on, not a back-channel for handing domain knowledge to the next agent). Reference the triggering ticket so the handoff is traceable.
2. If none of your open tickets covers this, run the duplicate check from `check-before-create` against the project's open tickets — the work may already be filed under someone else, including the role that should own it. If a matching open ticket exists, comment there (and @-mention the assignee if it is not you) instead of opening a new one. Only when nothing covers the work do you call `create_issue` to open one and assign it to yourself. The new ticket is your own first-class work; shape it as the context warrants:
   - a sub-issue (set `parent_issue_id` to the triggering ticket) when the work clearly belongs underneath it,
   - a peer/sibling ticket when it sits alongside,
   - a top-level ticket when it is broader than the triggering scope.
   The system records the triggering ticket as provenance automatically via `created_by_run_id`; you don't need to restate that linkage in the description unless it helps a future reader.
3. Acknowledge the handoff by reacting to the triggering comment with `add_reaction(kind='ack')`. **Do not** post a follow-up `create_comment` for a routine acknowledgement — reactions do not wake the original commenter, comments do. The mentioner will see the ✓ next time it works the ticket and know the handoff landed. Then end the turn — do not modify the triggering ticket further. Your next heartbeat picks up your own ticket (if any) and continues work there.
4. Post a `create_comment` instead of (or in addition to) the reaction **only** when the mentioner needs to see something now: a direct question you can answer as the authority on that ticket, a blocker they have to unblock, a decision they have to take, or context they cannot get from the ticket you've opened. That comment will wake them.

Reactions never wake the comment author; comments still do (per-company `settings.wake_mentioner_on_reply`). Choose between reaction and comment with that in mind.
