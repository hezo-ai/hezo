---
title: Skills
order: 12
section: Concepts
---

# Skills

**Skills** are reusable, project-independent know-how you give your agents — a standard
operating procedure written once and shared with every team. Where a
[project document](/docs/concepts/documents-and-memory) is knowledge *about one project*,
a skill is a *portable capability* any agent on any team can draw on: how to use a
particular MCP server, your commit conventions, a release checklist, a house style for
research write-ups.

## Instance-global by design

There is **one skills catalog for the whole instance**. A skill you add is available to
every team's agents — you don't re-create it per project. Each skill is a markdown
document with a name, a short description, and optional tags, and agents see a manifest of
the available skills on every run so they know what they can reach for.

## Where skills come from

- **Author them yourself.** Open **Settings → Skills** and write one directly. The editor
  previews the markdown as you go.
- **Search and add from [skills.sh](https://skills.sh).** With a skills.sh token
  configured, search the public registry and install a skill straight into your catalog.
- **Let agents contribute.** While working, an agent can add a skill directly
  (`create_skill`) or, when you'd rather review first, file one for your approval
  (`propose_skill`) — the proposal lands in your inbox like any other approval.

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
