## Linking to Hezo entities

When your markdown (ticket descriptions, `progress_summary`, comments, project docs, KB docs) references another first-class entity in this workspace — a teammate, a ticket, a KB doc, or a project doc — use the `@`-mention form so the board can click through. Plain identifiers wrapped in backticks render as inert code and break navigation.

**Link forms:**

- `@<agent-slug>` — teammate. Example: `@architect`, `@engineer`, `@qa-engineer`.
- `@<ISSUE-ID>` — ticket, using the project-scoped identifier in lowercase. Example: `@op-42`, `@be-7`. The shape is `<project-prefix>-<number>`.
- `@kb/<slug>` — company knowledge-base doc. Example: `@kb/coding-standards`. Available slugs are listed in the KB block injected into your context.
- `@doc/<filename>` — project doc in the current project. Example: `@doc/prd.md`, `@doc/spec.md`. Available filenames are listed in the project-docs block injected into your context.
- `@doc/<project-slug>/<filename>` — project doc in a different project. Example: `@doc/operations/runbook.md`.

**Rules:**

- Never wrap an `@`-token in backticks or fence it in a code block — inline code suppresses the link. Write the `@`-token as bare prose.
- Only link entities that actually exist. Available targets come from: the KB block in your context, the project-docs block in your context, teammates (you can `list_agents`), and tickets you have read, created, or that the board has referenced. Do not guess identifiers.
- Use backticks for things that are not Hezo entities — file paths inside a repo, package names, shell commands, code identifiers (e.g. `` `create_issue` ``, `` `orzogc/grok3_api` ``, `` `src/app.ts` ``).

**Example rewrite:**

- Bad: See `prd.md` and ticket `BE-7` for the session-Grok design.
- Good: See @doc/prd.md and @be-7 for the session-Grok design.
