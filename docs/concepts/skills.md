---
title: Skills
order: 13
section: Concepts
---

# Skills

**Skills** are reusable know-how you give your agents — a standard operating procedure
written once and reached for whenever it's relevant. Where a
[project document](/docs/concepts/documents-and-memory) is knowledge *about one project*,
a skill is a *portable capability* an agent can draw on: how to drive a particular
connected service, your commit conventions, a release checklist, a house style for
research write-ups.

Each skill is a markdown document with a name, a short description, and optional tags. On
every run agents are given a **manifest** of the skills available to that run — each one's
name and description, not its full body — so they know what they can reach for; an agent then
loads a skill's full instructions on demand when it's relevant to the task. That
manifest-plus-load-on-demand pattern is part of how Hezo gives agents
[long-term memory](/docs/concepts/documents-and-memory#what-an-agent-carries-into-every-run)
without bloating every prompt.

## Global and project scope

Every skill is either **global** or **scoped to one project**:

- **Global** skills are shared with every project — the right home for know-how any agent
  might need (a widely-used tool's usage, a general technique).
- **Project** skills are private to a single project — its particular deployment steps, its
  own conventions, a runbook only that project needs.

A run sees its own project's skills **plus** all global ones; if a project skill and a global
skill share the same slug, the project's copy takes precedence for that project. This keeps
each project's manifest focused while still letting broadly-useful know-how reach everyone.

## Where skills come from

- **Author them yourself.** Open **Settings → Skills** — the global Skills page — and write
  one directly, choosing its scope (global, or a specific project) as you add it. The editor
  previews the markdown as you go.
- **Search and add from [skills.sh](https://skills.sh).** With a skills.sh token
  configured, search the public registry and install a skill straight into your catalog.
- **Let agents contribute.** While working, an agent can add a skill directly
  (`create_skill`) or, when you'd rather review first, file one for your approval
  (`propose_skill`) — the proposal lands in your inbox like any other approval. The agent
  chooses whether the new skill is global or project-scoped, and defaults to the current
  project when it doesn't say.
- **Built in.** Hezo ships a **starter library of global skills** — proven methods for
  planning, brainstorming, debugging, test-driven development, code review, verification,
  design, web app testing, research, data analysis, writing, and authoring new skills.
  They appear on **Settings → Skills** like any skill you wrote yourself, and they're
  **fully yours**: edit them, delete them, or re-scope them to a single project. Hezo
  updates a starter skill in place only while you've never edited it — an edited copy
  stays yours forever (with the shipped version still in its revision history), and a
  deleted one never comes back. Several are adapted from well-known open-source skill
  collections and link their source.

  One built-in skill is special: **`connector-recipes`**, a curated catalog of connection
  recipes agents consult before
  [connecting an external service](/docs/mcp/connecting-mcp-servers). It appears with a
  **Built-in** badge on **Settings → Skills** and — because it's global — on every
  project's **Skills** page too, is read-only — it can't be edited or deleted — and
  updates automatically as Hezo does. Open it (the **view** button on its row) to read the
  full recipe catalog.

Agents contribute proactively for connected services: once an agent gets a
[connector](/docs/mcp/connecting-mcp-servers) to a third-party service working, it records
how to drive that service as a skill — and keeps the skill updated as it learns more — so
teammates can use the connection without re-deriving the integration from vendor docs. The
skill's scope follows the connector's: a connector shared with every project gets a global
skill, a project's own connector a project skill. Where a good public skill already exists
on [skills.sh](https://skills.sh), agents persist that one into your catalog instead of
writing their own, and layer anything project-specific as a separate project skill that
references it.

## Managing scope

The global **Settings → Skills** page lists **every** skill — global and each project's —
and each row has a scope drop-down so you can move a skill between global and any project (it
works just like the [Connectors](/docs/mcp/connecting-mcp-servers) page). Each project also has its
own **Skills** page, under **Connectors** in the project's settings menu, showing that
project's skills plus the globals; you can edit or remove the project's own skills there,
while global ones are shown for reference and stay managed on the global page. Every row —
on either page — has a **view** button that opens the skill and renders its full markdown so
you can read exactly what your agents see, including read-only built-ins.

Skills are part of what the [Coach](/docs/concepts/coach-and-self-improving-teams) can
write to: when a retrospective surfaces a reusable procedure, it may capture it as a skill
so the whole instance benefits.

## Version history & restore

Every change to a skill's content is **versioned automatically**. From a skill's editor in
**Settings → Skills**, open its **revision history** to see each past version — who changed
it and when — and **restore** any earlier one with a click. Restoring is itself recorded as
a new revision, so you can always move forward or back without losing the thread. This is
the same "versioned & reversible" guarantee that covers
[project documents and agent system prompts](/docs/concepts/documents-and-memory#version-history).

## Finding skills

Skills are part of [global search](/docs/concepts/search) — one query covers tasks,
comments, documents, and skills — so a skill you wrote months ago is easy to find again.
