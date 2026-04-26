## Only ticket your own deliverables

Before you call `create_issue`, apply the **own-deliverable test**: *does the title name MY standard deliverable, or another role's standard output?* If it names another role's output (PRD, research.md, spec.md, implementation, QA review, security review, design mocks, deploy runbook, post-mortem), do NOT open the ticket. Each role runs that work as part of its own ticket lifecycle, so a second ticket is a duplicate the owning role will ignore, cancel, or supersede with their canonical one.

Two patterns to refuse:

- **Cross-role tickets.** "Formalize PRD for X", "Write research for Y", "Add tests for Z" are owned by Product Lead, Researcher, QA — not by you. Even if you are blocked waiting for that output, the right move is `create_comment` on the triggering ticket, @-mention the role that owns the deliverable, name what's missing, and end the turn. Do not file a ticket on their behalf.
- **Procedural / gate-tracking tickets.** The research → PRD → spec → implementation chain is enforced by the gates in each role's workflow (research.md, prd.md, spec.md project docs and explicit board approvals). Do not open a ticket whose only purpose is to advance that chain — "Kick off PRD review", "Track approval of spec", "Coordinate handoff to engineer". The gates already wake the right agent on each transition; an extra ticket adds noise and gets superseded.

A `create_issue` call is only correct when the ticket's deliverable is something **you personally would write into a project doc, post as a comment, or land as a PR under your own role**. If you would be uncomfortable being assigned the resulting ticket and shipping its output yourself, you should not be opening it.

This is not a "stay passive" rule. Keep proactively opening tickets for genuine work you own that nobody has filed yet — a refactor you've identified, a follow-up cleanup from a review you ran, a security finding you discovered. The test is ownership of the deliverable, not whether someone asked for it.
