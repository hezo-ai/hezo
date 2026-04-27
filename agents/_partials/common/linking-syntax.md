## Linking to Hezo entities

When your markdown (ticket descriptions, `progress_summary`, comments, project docs, KB docs) references another first-class entity in this workspace, render the reference in its bare form so the board can click through. Plain identifiers wrapped in backticks render as inert code and break navigation.

**Link forms:**

- `@<agent-slug>` — teammate. The `@` prefix is **reserved for teammates only**. Example: `@architect`, `@engineer`, `@qa-engineer`.
- `<ISSUE-ID>` — ticket, using the project-scoped uppercase identifier. Example: `OP-42`, `BE-7`. Shape: `<project-prefix>-<number>`. No prefix — write the bare identifier.
- `<kb-doc-filename>` — company knowledge-base doc, stored as a markdown file. Example: `coding-standards.md`. Available filenames are listed in the KB block injected into your context. No prefix — write the bare filename.
- `<project-doc-filename>` — project doc in the current project. Example: `prd.md`, `spec.md`. Available filenames are listed in the project-docs block injected into your context. No prefix — write the bare filename.

**Rules:**

- Only teammates get the `@` prefix. Tickets, KB docs, and project docs are bare — the rendered UI detects them by shape (uppercase ID pattern for tickets, filename with extension for KB and project docs).
- Always use the slug form for teammates, never the title. Write `@product-lead`, not `Product Lead` or `@Product Lead`. Slugs are lowercase, hyphenated, and unique; titles are display strings and don't resolve. The Teammates block injected at the end of your prompt is the authoritative slug list — even when a role section earlier in this prompt names a teammate by title, write the reference as `@<slug>`.
- No other prefix is valid. Never write `#kb/<filename>`, `#doc/<filename>`, `kb/<filename>`, or `doc/<filename>` — those forms are not recognised. Just the bare filename or identifier.
- Never wrap any of these in backticks or fence them in a code block — inline code suppresses the link. Write them as bare prose.
- Only link entities that actually exist. Available targets come from: the KB block in your context, the project-docs block in your context, teammates (you can `list_agents`), and tickets you have read, created, or that the board has referenced. Do not guess identifiers.
- Use backticks for things that are not Hezo entities — file paths inside a repo, package names, shell commands, code identifiers (e.g. `` `create_issue` ``, `` `orzogc/grok3_api` ``, `` `src/app.ts` ``).

**Example rewrite:**

- Bad: See `prd.md` and ticket `BE-7` for the session-Grok design, assigned to `@engineer`.
- Good: See prd.md and BE-7 for the session-Grok design, assigned to @engineer.
- Bad: Delegating PRD work to Product Lead and research to Researcher.
- Good: Delegating PRD work to @product-lead and research to @researcher.
