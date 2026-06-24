---
title: Documents & long-term memory
order: 9
section: Concepts
---

# Documents & long-term memory

Agents are at their best when they don't start cold. Hezo gives every project a set of
**documents** — durable, markdown knowledge that lives with the project and outlasts any
single run. This is the team's long-term memory: context, decisions, and plans are written
down once and read back whenever they're needed, instead of being re-derived on every run.

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

## Version history

Every change to a document is versioned. The Documents page shows the full **revision
history**, and you can **restore** any earlier version with a click. Because you and the
agents write to the same documents, that history doubles as an audit trail — you can see how
a spec evolved and roll back a bad edit without losing the thread.

## Chatbox memory

The CEO keeps a special, permanent document — its **chatbox memory** — so your standing
preferences and guidelines carry across every conversation. Tell the CEO once how you like
things done and it records the durable facts there, then reads them back on every turn. Live
data such as project lists and rosters is deliberately *not* memorised — that's always read
fresh from Hezo. See [Roles & the CEO](/docs/concepts/roles-and-coordination).

## Documents vs. the task summary

Both are memory, at different scopes:

- A task's **progress summary** is the living checkpoint for *one task* — where that ticket
  stands right now. See [Tasks, rules & summaries](/docs/concepts/tasks).
- **Documents** are *project-wide* knowledge that many tasks and agents draw on — the spec,
  the plan, the research.
