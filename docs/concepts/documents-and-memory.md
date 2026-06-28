---
title: Documents & long-term memory
order: 12
section: Concepts
---

# Documents & long-term memory

Agents are at their best when they don't start cold. Hezo gives every project a
**long-term memory**: the durable context a team accumulates — decisions, plans,
conventions, and where each task stands — is written down once and read back into every
run, instead of being re-derived (or lost) each time an agent wakes.

That memory lives at a few different scopes, and each one is kept current by you *and* by
the agents as they work:

- **Per task** — the [rules, description, and progress summary](/docs/concepts/tasks) that
  say how a task should be worked and where it stands, plus the comment thread an agent
  reads to catch up on what's happened.
- **Per project** — the **Documents** library of PRDs, specs, and research the whole team
  keeps coming back to.
- **Global** — [skills](/docs/concepts/skills), the reusable know-how every team can
  reach for.
- **Per team** — [preferences](#team-preferences): custom instructions applied to every
  agent on a team.
- **The CEO's** — its [chatbox memory](#chatbox-memory) of your standing preferences and
  guidelines.

## What an agent carries into every run

Hezo assembles an agent's context **fresh on every run**, from the latest state in the
database — so an edit you or another agent made lands on the very next run, with nothing
cached to go stale. Context reaches the agent in one of two ways:

- **In full** — short, always-relevant text is injected verbatim: the current task's
  **rules**, **description**, and **progress summary**; the team's **preferences**; and, for
  the CEO, its **chatbox memory**. These are small and central, so the agent always has them
  in view.
- **As a manifest** — larger libraries are surfaced as a *table of contents* rather than
  pasted in whole. The agent sees an index of what exists and pulls the full item only when
  it's relevant: **project documents** are listed by filename, title, and last-updated date
  (the agent opens one with `read_project_doc`), and **skills** are listed by name and
  description (the agent loads one with `get_skill`). This keeps prompts lean while still
  putting the entire library within reach.

| Memory | Scope | How it reaches the agent | Kept current by |
|---|---|---|---|
| Rules | One task | In full, every run | You and agents |
| Progress summary | One task | In full, every run | You and agents |
| Comment thread | One task | Read by the agent at the start of a run | You and agents |
| Project documents | One project | Manifest, full text on demand | You and agents |
| Skills | Whole instance | Manifest, full text on demand | You and agents |
| Team preferences | One team | In full, every run | You |
| Chatbox memory | The CEO | In full, every chat turn | You and the CEO |

For how rules, the progress summary, and the thread work together on a single task — and
how an agent uses them to pick up where the last run left off — see
[Tasks, rules & summaries](/docs/concepts/tasks).

## Project documents

Each project has a **Documents** library for the high-level context a team keeps coming
back to:

- **PRDs and specs** — what you're building and why.
- **Implementation plans** — how the work is sequenced.
- **Research and decisions** — what was investigated, what was chosen, and the reasoning.

Documents are markdown, and they live in Hezo — not in the project's source repository — so
every agent can reach them without cluttering the codebase. You read and edit any document
from the **Documents** page in the web app, and agents read and write the same files as they
work (`list_project_docs`, `read_project_doc`, and `write_project_doc` over Hezo's
[MCP server](/docs/mcp/hezo-mcp-server)). A document is referenced by its plain filename —
for example `spec.md` — so links stay stable as the work evolves.

Agents don't carry every document's full text on every run. Instead each run includes a
**manifest** — a table of contents listing each document's filename, title, and when it
last changed — and the agent opens the ones it needs with `read_project_doc`. So adding or
updating a document immediately makes it discoverable to the whole team, without bloating
anyone's prompt.

## Version history

Every change to a document is versioned. The Documents page shows the full **revision
history**, and you can **restore** any earlier version with a click. Because you and the
agents write to the same documents, that history doubles as an audit trail — you can see how
a spec evolved and roll back a bad edit without losing the thread.

This **versioned-and-reversible** guarantee isn't limited to project documents. The same
applies to **agent system prompts** — every edit, including the
[learned rules the Coach adds](/docs/concepts/coach-and-self-improving-teams#every-change-is-reversible),
is snapshotted and restorable from the agent's settings — to a team's
[preferences](#team-preferences), and to
[**skills**](/docs/concepts/skills#version-history--restore), your reusable cross-team
know-how. Whatever your agents change, you can see what changed and put it back.

## Chatbox memory

The CEO keeps a single, permanent memory document — its **chatbox memory**, the file
`chat-memory.md` — so your standing preferences and guidelines carry across every
conversation. Its full contents are injected into **every** chat turn, so anything recorded
there survives even after older messages scroll out of the conversation window.

Tell the CEO once how you like things done — "always run a plan past me before provisioning a
team", "we deploy on Fridays", "default new services to TypeScript" — and it records the
durable facts there, then reads them back on every turn. Live data such as project lists and
rosters is deliberately *not* memorised — that's always read fresh from Hezo, so it can never
go stale.

You're not limited to dictating to the CEO. The chatbox memory is a document you can **read
and edit yourself**: it lives in the
[HQ](/docs/concepts/projects-and-teams#hq--the-home-team) project's documents (and is
explained under **Settings → Chatbox**), so you can seed it with preferences up front or
prune stale entries later. It's permanent — it can't be deleted. See
[Roles & the CEO](/docs/concepts/roles-and-coordination).

## Team preferences

Where the chatbox memory steers the CEO, a team's **preferences** steer that team's workers.
Preferences are free-form **custom instructions applied to every agent on the team** —
house conventions, tone, standing do's and don'ts — set from the team's settings and injected
in full into each agent's prompt on every run. They're the lighter-weight choice when the
guidance applies to the whole roster rather than one role, and, like documents and system
prompts, every edit is **versioned and restorable**.

## Where each kind of knowledge goes

All of the above is memory, but each piece has a natural home — putting knowledge in the
right place is what keeps it findable and applied at the right moment:

- **Where one task stands right now** → that task's **progress summary**.
- **How a single task must be worked** (guardrails, required steps) → that task's
  **rules**.
- **What a task is and the domain context to do it** → that task's **description**.
- **Project-wide knowledge many tasks draw on** (the spec, the plan, the research) →
  a **project document**.
- **Reusable, project-independent know-how** (how to use an MCP server, a release
  checklist, a house style) → a **[skill](/docs/concepts/skills)**.
- **A standing instruction for every agent on a team** → that team's **preferences**.
- **Your durable preferences for how the CEO works with you** → the CEO's **chatbox
  memory**.

When in doubt, keep task-specific status in the summary, how-to-work constraints in the
rules, and anything the wider team will need again in a document or a skill.
