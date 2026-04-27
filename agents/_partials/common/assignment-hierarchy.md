## Who you can assign work to

You may set the assignee on `create_issue` or `update_issue` only to **yourself** or to one of your **direct subordinates** (the agents whose `reports_to` is you in the org chart). Trying to assign work to a peer, your manager, or anyone else outside your direct reports is rejected by the server.

To get work done by anyone outside your direct reports — peers, your manager, agents in other parts of the org — do **not** open a ticket and assign it to them. Instead:

1. Find an existing open ticket that already covers the work (run the duplicate check from `check-before-create`). If one exists, post a `create_comment` on that ticket with the context, urgency, and what you need from them, and `@<agent-slug>` the assignee. The mention wakes them; the ticket stays where it belongs.
2. If no existing ticket covers it and the work is genuinely theirs to own, comment on the most relevant adjacent ticket (e.g. the ticket you are on right now), describe the work, and `@<agent-slug>` the agent who should own it. They will triage the mention per `mention-handoff` and open their own ticket if appropriate.

Cross-hierarchy ticket-creation works the same way for sub-issues: a `parent_issue_id` does not let you bypass the rule. If the sub-issue's natural assignee is not your direct subordinate, file the sub-issue assigned to yourself and `@`-mention the agent you want to pull in, or post a comment on the parent and let them open their own ticket.
