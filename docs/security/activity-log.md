---
title: Activity log & audit trail
order: 17
section: Security
---

# Activity log & audit trail

Every project keeps a complete, automatic **activity log** — an append-only record of
everything that happened, newest first. You never switch it on, and nothing can quietly
edit or delete it after the fact. When you need to know *who did what, and when* — a person
or an agent — this is where you look.

## What gets recorded

The log captures every state-changing action on the project:

- **Tasks** — created, renamed, status changes, reassignments.
- **Agent runs** — each run started and completed, with its outcome.
- **Documents** — created, updated, and deleted, including edits to an agent's instructions.
- **Assets** — files uploaded to the project or a task.
- **Agents** — hired, updated, enabled, and disabled.
- **Connectors** — MCP connections and OAuth account connections changing.
- **Outbound traffic** — every request an agent made that used one of your secrets (see below).

Each entry names the **actor** (you, an agent, the system, or a connected external agent),
so a human action and an automated one are always told apart.

## Reading the log

Open a project and choose **Activity** in the sidebar. Entries are listed newest-first with
three columns:

- **Time** — when it happened.
- **Actor** — who did it, with a badge distinguishing a person from an agent.
- **Activity** — a plain-language description ("Created task TO-4", "Changed status of TO-4
  from Backlog to In Progress"). Most rows link straight to the task, agent, or page they
  concern.

You can narrow the view by entity type, action, and date range.

## Outbound traffic (the egress audit)

The **Outbound traffic** tab shows every outbound HTTPS request from an agent's container
that Hezo's egress proxy substituted a secret into — or denied. Each row records the
destination host, the request method and path, the response status, the **names** of the
secrets used, and which agent made the call.

The secret **values are never recorded** — only their names. This gives you a precise trail
of which credential was used, against which host, by which agent, without ever writing the
secret itself to disk. See [Secret protection & egress](/docs/security/secret-protection)
for how the substitution works.

## Project and instance views

There are two scopes:

- **Project Activity** — everything for a single project, on its **Activity** page. This is
  what your project team uses day to day.
- **Instance Activity** — an Admin-only view under instance settings that combines the
  activity of **all projects** plus instance-level admin actions that aren't tied to any one
  project (managing credentials, connectors, and skills). It's the single place to
  reconstruct what happened across the whole instance, and adds a **Project** column so you
  can see where each action belongs.

## Why it matters

The activity log makes Hezo's autonomy accountable. Agents act on their own, but every
action they take — and every secret they use — is on the record, attributed, and impossible
to rewrite. When something looks off, you can trace exactly what happened and roll back from
a position of knowledge.
