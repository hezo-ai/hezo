## Linking to Hezo entities

When your markdown (ticket descriptions, `progress_summary`, comments, project docs, KB docs) references another first-class entity in this workspace, render the reference in its bare form so the board can click through. Plain identifiers wrapped in backticks render as inert code and break navigation.

**Link forms:**

- `@<agent-slug>` — **active** teammate reference. Renders as a clickable chip *and* wakes that teammate on the ticket where the comment is posted. Use only when you want them to act on *this* ticket. Example: `@architect please confirm the spec here.`
- `@@<agent-slug>` — **passive** teammate reference. Renders as the same clickable chip but does **not** wake the teammate. Use when you're describing who owns *another* ticket, listing assignees in a plan or fan-out table, or naming someone in a wrap-up summary. Example: `BE-2 is assigned to @@researcher.`
- `<TASK-ID>` — ticket, using the project-scoped uppercase identifier. Example: `IN-42`, `BE-7`. Shape: `<project-prefix>-<number>`. No prefix — write the bare identifier.
- `<kb-doc-filename>` — team knowledge-base doc, stored as a markdown file. Example: `coding-standards.md`. Available filenames are listed in the KB block injected into your context. No prefix — write the bare filename.
- `<project-doc-filename>` — project doc in the current project. Example: `prd.md`, `spec.md`. Available filenames are listed in the project-docs block injected into your context. No prefix — write the bare filename.

**Rules:**

- Only teammates get the `@` or `@@` prefix. Tickets, KB docs, and project docs are bare — the rendered UI detects them by shape (uppercase ID pattern for tickets, filename with extension for KB and project docs).
- Always use the slug form for teammates, never the title. Write `@product-lead`, not `Product Lead` or `@Product Lead`. Slugs are lowercase, hyphenated, and unique; titles are display strings and don't resolve. The Teammates block injected at the end of your prompt is the authoritative slug list — even when a role section earlier in this prompt names a teammate by title, write the reference as `@<slug>` (active) or `@@<slug>` (passive).
- Pick `@` vs `@@` by intent, not aesthetics. `@<slug>` is for direct asks, decisions, or handoffs that the teammate must triage *on this ticket*. `@@<slug>` is for everything else — naming, attribution, plan tables, summaries.
- No other prefix is valid. Never write `#kb/<filename>`, `#doc/<filename>`, `kb/<filename>`, or `doc/<filename>` — those forms are not recognised. Just the bare filename or identifier.
- Never wrap any of these in backticks or fence them in a code block — inline code suppresses the link. Write them as bare prose.
- Only link entities that actually exist. Available targets come from: the KB block in your context, the project-docs block in your context, teammates (you can `list_agents`), and tickets you have read, created, or that the board has referenced. Do not guess identifiers.
- Use backticks for things that are not Hezo entities — file paths inside a repo, package names, shell commands, code identifiers (e.g. `` `create_task` ``, `` `orzogc/grok3_api` ``, `` `src/app.ts` ``).

**Example rewrite:**

- Bad: See `prd.md` and ticket `BE-7` for the session-Grok design, assigned to `@engineer`.
- Good: See prd.md and BE-7 for the session-Grok design, assigned to @@engineer.
- Bad (passive reference uses `@`, would wake everyone listed): `Planning chain: BE-2 → @researcher, BE-3 → @product-lead, BE-4 → @architect.`
- Good: `Planning chain: BE-2 → @@researcher, BE-3 → @@product-lead, BE-4 → @@architect.`
- Good (active address, you want product-lead to act on this ticket): `@product-lead — please confirm the PRD scope before the architect picks this up.`
