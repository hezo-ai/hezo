---
title: Activity log & audit trail
order: 22
section: Security
---

# Activity log & audit trail

Every project keeps a complete, automatic **activity log** - an append-only record of
everything that happened, newest first. You never switch it on, and nothing can quietly
edit or delete it after the fact. When you need to know *who did what, and when* - a person
or an agent - this is where you look.

Open a project and choose **Activity** in the sidebar. The page has two tabs: **Log**, the
record described below, and **Hours**, which reports how long each agent spent working.

## What gets recorded

The log captures every state-changing action on the project:

- **Tasks** - created, renamed, status changes, reassignments.
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

On the **Log** tab, entries are listed newest-first with three columns:

- **Time** - when it happened.
- **Actor** - who did it. A badge flags human admins and external MCP clients (API keys); the actor's name is always shown.
- **Activity** - a plain-language description ("Created task TO-4", "Changed status of TO-4
  from Backlog to In Progress"). Most rows link straight to the task, agent, or page they
  concern.

The log loads the most recent entries first, in pages. **Load older activity** at the
bottom of the list fetches the next page and appends it, so you can walk back through the
whole history as far as you need without waiting for it all up front.

## Hours per agent

The **Hours** tab answers the other question the log raises: not just what the team did,
but how long it took. It reports **wall-clock run time** - the time from a run starting to
it finishing - summed per agent, and it counts every finished run, whether or not the run
was working on a task. Runs still in flight are not counted; they have no duration yet.

Choose **Day**, **Week** or **Month** to change the bucket the chart groups by. The most
recent bucket is always still filling, so it reads low until the period closes. Below the
chart, each agent gets a row with its time today, this week and this month, its run count,
its average run length, and its share of the month.

Hours are about time, not money. For what those runs cost, see
[Budgets & cost control](/docs/concepts/budgets-and-costs) - the two are computed from the
same runs, so a busy agent that is cheap to run shows up as exactly that.

## Project and instance views

There are two scopes:

- **Project Activity** - everything for a single project, on its **Activity** page. This is
  what your project team uses day to day, and the only scope that carries the Hours tab.
- **Instance Activity** - an Admin-only view under instance settings that combines the
  activity of **all projects** plus instance-level admin actions that aren't tied to any one
  project (managing credentials, connectors, and skills). It's the single place to
  reconstruct what happened across the whole instance, and adds a **Project** column so you
  can see where each action belongs.

## Why it matters

The activity log makes Hezo's autonomy accountable. Agents act on their own, but every
state-changing action they take is on the record, attributed, and impossible
to rewrite. When something looks off, you can trace exactly what happened and roll back from
a position of knowledge.
