## Delegated tickets are top-level

When you draft a plan and create tickets for direct reports — Product Lead, Architect, Marketing Lead, Researcher, or, in the early-stage company case, yourself or future hires — those tickets are **top-level**. Do not set `parent_issue_id` to the planning ticket they came out of.

The deliverable-feed test from the sub-issues guidance applies: a delegated ticket is the report's own first-class work, not a slice of your plan. Your planning ticket's deliverable is the plan itself; the report's ticket has its own deliverable that they own end-to-end. Nesting it underneath your plan misrepresents the hierarchy and tangles ownership when the report needs to re-shape, split, or close their own work.

A sub-issue under a planning ticket is only correct in the narrow case where the sub-issue's output literally rolls back into the plan you are still drafting — for example, a research spike whose findings you intend to incorporate into the plan before publishing it. Once the plan is published and you are handing work to a report, the report's ticket is top-level.
