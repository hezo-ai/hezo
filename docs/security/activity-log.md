---
title: Activity log & audit trail
order: 22
section: Security
---

# Activity log & audit trail

Every project keeps an automatic **activity log** - an append-only record of supported
project changes, newest first. You never switch it on, and nothing can quietly edit or
delete an entry after the fact. When you need to know *who did what, and when* - a person
or an agent - this is where you look.

Open a project and choose **Activity** in the sidebar.

## What gets recorded

The log captures these project actions:

- **Tasks** - created; direct edits to title, description, status, priority, assignee,
  progress summary, rules, branch, runtime, and parent.
- **Agent runs** - each run started and completed, with its outcome.
- **Documents** - created, updated, archived, restored, and deleted, including edits to an
  agent's instructions.
- **Assets** - files uploaded to the project or a task, and files archived, restored, or
  deleted.
- **Agents** - hired, updated, enabled, and disabled.
- **Connectors** - MCP connections and OAuth account connections changing.

Each entry names the **actor** (you, an agent, the system, or an external MCP client),
so a human action and an automated one are always told apart. Archiving and restoring are
recorded distinctly from an ordinary edit, so restoring a retired document or asset is
never mistaken for a routine change - and when an agent does it, the entry names the task
and run it came from.

## Reading the log

Entries are listed newest-first with three columns:

- **Time** - when it happened.
- **Actor** - who did it. A badge flags human admins and external MCP clients (API keys); the actor's name is always shown.
- **Activity** - a plain-language description ("Created task TO-4", "Changed status of TO-4
  from Backlog to In Progress"). Most rows link straight to the task, agent, or page they
  concern.

The log loads the most recent entries first, in pages. **Load older activity** at the
bottom of the list fetches the next page and appends it, so you can walk back through the
whole history as far as you need without waiting for it all up front.

## How long it took

The log says what happened; the **Budget** page says what it cost, in both senses. Each
agent's run time for the month sits beside its spend on the **Spend** tab, and the
**Hours** tab reports what the project's containers cost in uptime - a different figure,
since containers are billed while they build and while they sit warm between runs, and
concurrent runs share one. See
[Budgets & cost control](/docs/concepts/budgets-and-costs).

## Project and instance views

There are two scopes:

- **Project Activity** - everything for a single project, on its **Activity** page. This is
  what your project team uses day to day.
- **Instance Activity** - an Admin-only view under instance settings that combines the
  activity of **all projects** plus instance-level admin actions that aren't tied to any one
  project (managing credentials, connectors, and skills). It's the single place to
  reconstruct what happened across the whole instance, and adds a **Project** column so you
  can see where each action belongs.

## Why it matters

The activity log makes Hezo's autonomy accountable. Agents act on their own, but supported
changes are recorded with their actor and cannot be rewritten. When something looks off, you
can trace the recorded activity and roll back from a position of knowledge.
