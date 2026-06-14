## Linking to Hezo entities

When your markdown (ticket descriptions, `progress_summary`, comments, project docs) references another first-class entity in this workspace, render the reference in its bare form so the admin can click through. Plain identifiers wrapped in backticks render as inert code and break navigation.

**Link forms:**

- `@<agent-slug>` — **active** teammate reference. Renders as a clickable chip *and* wakes that teammate on the ticket where the comment is posted. Use only when you want them to act on *this* ticket — a single, deliberate ask, rarely more than one per comment. Example: `@architect please confirm the spec here.`
- `@@<agent-slug>` — **passive** teammate reference, and the **default** for any reference that isn't a direct ask. Renders as the same clickable chip but does **not** wake the teammate. Use when you're describing who owns *another* ticket, listing assignees in a plan or fan-out table, crediting a reviewer in a status update or recap, or naming someone in a wrap-up summary. Example: `BE-2 is assigned to @@researcher.`
- `@admin` — **active** admin reference. The admin is the team's human project-owner group. Active `@admin` lands a row in every the admin's inbox, surfacing your question for human review. Use only when you genuinely cannot proceed without a human decision (product/strategy/sensitive trade-off) — then stop your turn and leave the task in a non-terminal status; the admin's reply wakes you automatically. `@@admin` is the passive form for narrative references and does not notify.
- `<TASK-ID>` — ticket, using the project-scoped uppercase identifier. Example: `IN-42`, `BE-7`. Shape: `<project-prefix>-<number>`. No prefix — write the bare identifier.
- `<TASK-ID>#comment-<public_id>` — a **specific comment** in a ticket, for pointing a teammate at an earlier remark instead of paraphrasing it ("the comment above"). Works for comments in *this* ticket and in any *other* ticket. Example: `IN-42#comment-20261009112345`. The `<public_id>` is the comment's `public_id` as returned by `list_comments` (a creation-timestamp slug, `YYYYMMDDHHMMSS`) — it renders as a clickable link that scrolls straight to that comment. Use this whenever you would otherwise write "the comment above", "my earlier comment", or "the paste form above".
- `<project-doc-filename>` — project doc in the current project. Example: `prd.md`, `spec.md`. Available filenames are listed in the project-docs block injected into your context. No prefix — write the bare filename.
- `assets/<filename>` — a file in the project assets library (mockups, wireframes, diagrams, exports). Example: `assets/ui-mockups.html`, `assets/login-wireframe.png`. Keep the `assets/` prefix and write it bare. Non-markdown deliverables belong in the assets library (author text-based ones with `write_project_asset`) — never commit them to the source repo.

Skills in the team skills database are referenced by their slug (e.g. `deploy-runbook`) as shown in the injected skills manifest, not by filename. Only reference skills you know exist.

**Rules:**

- Only teammates and the admin get the `@` or `@@` prefix. Tickets and project docs are bare — the rendered UI detects them by shape (uppercase ID pattern for tickets, filename with extension for project docs).
- Always use the slug form for teammates, never the title. Write `@product-lead`, not `Product Lead` or `@Product Lead`. Slugs are lowercase, hyphenated, and unique; titles are display strings and don't resolve. The Teammates block injected at the end of your prompt is the authoritative slug list — even when a role section earlier in this prompt names a teammate by title, write the reference as `@<slug>` (active) or `@@<slug>` (passive).
- **Passive is the default — reach for single-`@` only as a deliberate ask.** Pick `@` vs `@@` by intent, not aesthetics. `@<slug>` is for direct asks, decisions, or asks that the teammate must triage *on this ticket*, and a comment rarely needs more than one. `@@<slug>` is for everything else — naming, attribution, crediting reviewers in a status update or review recap, plan tables, summaries, and **handoffs whose wake is already covered by a status transition or `blocked_by` cascade** (the structural wakeup fires on the recipient's own ticket; an `@` here would only wake them on yours).
- No other prefix is valid. Never write `#doc/<filename>` or `doc/<filename>` — those forms are not recognised. Just the bare filename or identifier.
- Comment links are bare like tickets — never backticked. Only use a comment `<public_id>` you actually read back from `list_comments`; never invent one. A `<TASK-ID>#comment-<public_id>` whose public_id you didn't fetch will link nowhere.
- Never wrap any of these in backticks or fence them in a code block — inline code suppresses the link. Write them as bare prose.
- Only link entities that actually exist. Available targets come from: the project-docs block in your context, teammates (you can `list_agents`), and tickets you have read, created, or that the admin has referenced. Do not guess identifiers.
- Use backticks for things that are not Hezo entities — file paths inside a repo, package names, shell commands, code identifiers (e.g. `` `create_task` ``, `` `orzogc/grok3_api` ``, `` `src/app.ts` ``). An `assets/<filename>` reference is a Hezo entity, not a repo path — write it bare, never in backticks.

**Example rewrite:**

- Bad: See `prd.md` and ticket `BE-7` for the session-Grok design, assigned to `@engineer`.
- Good: See prd.md and BE-7 for the session-Grok design, assigned to @@engineer.
- Bad (passive reference uses `@`, would wake everyone listed): `Planning chain: BE-2 → @researcher, BE-3 → @product-lead, BE-4 → @architect.`
- Good: `Planning chain: BE-2 → @@researcher, BE-3 → @@product-lead, BE-4 → @@architect.`
- Good (active address, you want product-lead to act on this ticket): `@product-lead — please confirm the PRD scope before the architect picks this up.`
- Bad (handoff comment uses `@`, but the cascade unblock will wake the architect on BE-4 and BE-5 already): `Admin approved. @architect — BE-4 (technical spec) and BE-5 (UI/UX design) are unblocked and ready for you.`
- Good: `Admin approved. @@architect — BE-4 (technical spec) and BE-5 (UI/UX design) unblock now.` Then mark this ticket `done` so the cascade fires; the architect wakes on BE-4 and BE-5, not on this PRD ticket.
- Bad (review recap pings every teammate it credits — wakes the whole roster, and the `@admin` lands a needless row in every admin's inbox): `From @ui-designer review (12 findings); @security-engineer flagged 3 — all addressed. @admin approved.`
- Good: `From @@ui-designer review (12 findings); @@security-engineer flagged 3 — all addressed. @@admin approved.` Crediting reviewers or the admin in a recap is attribution, not an ask — keep it passive.
- Bad (paraphrases an earlier comment instead of linking it): `As I noted in the comment above, paste the token into the request form.`
- Good: `As I noted in IN-42#comment-20261009112345, paste the token into the request form.` Point at the exact comment so the reader can jump to it.
