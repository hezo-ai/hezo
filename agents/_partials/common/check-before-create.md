## Check before you create

Before every `create_issue` call, check whether an open ticket in this project already covers the same deliverable. Use `list_issues` filtered by the project, scan titles and descriptions for the same outcome (semantic match, not just the same words), and confirm the ticket is still open (not `closed`).

If a matching open ticket exists:

- If it is assigned to someone else, post a `create_comment` on it with whatever you wanted to add (context, urgency, blockers) and @-mention the assignee. Do not open a second ticket.
- If it is assigned to you, work on it instead of opening a new one.
- If it is stale or blocked on the wrong thing, use `update_issue` to fix it. Do not create a parallel ticket alongside it.

Only call `create_issue` once you have confirmed nothing covers this. Two tickets for the same deliverable is always a bug — the second one will be ignored, cancelled, or superseded, and time is wasted reconciling them. The check applies whether you are filing for yourself or another role: a CEO drafting work for a Product Lead, an Architect noting a PRD gap and filing it for the Product Lead, an Engineer surfacing a security finding for the Security Engineer — all of these are legitimate, but each must pass the duplicate check first.
