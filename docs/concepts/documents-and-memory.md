---
title: Documents & long-term memory
order: 12
section: Concepts
---

# Documents & long-term memory

Agents are at their best when they don't start cold. Hezo gives every project a
**long-term memory**: the durable context a team accumulates - decisions, plans,
conventions, and where each task stands - is written down once and read back into every
run, instead of being re-derived (or lost) each time an agent wakes.

That memory lives at a few different scopes, and each one is kept current by you *and* by
the agents as they work:

- **Per task** - the [rules, description, and progress summary](/docs/concepts/tasks) that
  say how a task should be worked and where it stands, plus the comment thread an agent
  reads to catch up on what's happened.
- **Per project** - the **Documents** library of PRDs, specs, and research the whole team
  keeps coming back to.
- **Global or per-project** - [skills](/docs/concepts/skills), reusable know-how that is
  either shared with every project or scoped to one.
- **Per project** - the [Custom Prompt](#custom-prompt): instructions applied to every
  agent in the project.
- **The CEO's** - its [long-term chat memory](#long-term-chat-memory) of your standing
  preferences and guidelines, kept automatically.

## What an agent carries into every run

Hezo assembles an agent's context **fresh on every run**, from the latest state in the
database - so an edit you or another agent made lands on the very next run, with nothing
cached to go stale. Context reaches the agent in one of two ways:

- **In full** - short, always-relevant text is injected verbatim: the current task's
  **rules**, **description**, and **progress summary**; the project's **Custom Prompt**; and, for
  the CEO, its **long-term chat memory**. These are small and central, so the agent always has
  them in view.
- **As a manifest** - larger libraries are surfaced as a *table of contents* rather than
  pasted in whole. The agent sees an index of what exists and pulls the full item only when
  it's relevant: **project documents** are listed by filename, a short description, and
  last-updated date (the agent opens one with `read_project_doc`), and **skills** are listed by name and
  description (the agent loads one with `get_skill`). This keeps prompts lean while still
  putting the entire library within reach.

| Memory | Scope | How it reaches the agent | Kept current by |
|---|---|---|---|
| Rules | One task | In full, every run | You and agents |
| Progress summary | One task | In full, every run | You and agents |
| Comment thread | One task | Read by the agent at the start of a run | You and agents |
| Project documents | One project | Manifest, full text on demand | You and agents |
| Skills | Global or one project | Manifest, full text on demand | You and agents |
| Custom Prompt | One project | In full, every run | You and agents |
| Long-term chat memory | The CEO | In full, every chat turn | The CEO (automatically) and you |

For how rules, the progress summary, and the thread work together on a single task - and
how an agent uses them to pick up where the last run left off - see
[Tasks, rules & summaries](/docs/concepts/tasks).

## Project documents

Each project has a **Documents** library for the high-level context a team keeps coming
back to:

- **PRDs and specs** - what you're building and why.
- **Implementation plans** - how the work is sequenced.
- **Research and decisions** - what was investigated, what was chosen, and the reasoning.

Documents are markdown, and they live in Hezo, not in the project's source repository, so
every agent can reach them without cluttering the codebase. You read and edit any document
from the **Documents** page in the web app, and agents read and write the same files as they
work (`list_project_docs`, `read_project_doc`, and `write_project_doc` over Hezo's
[MCP server](/docs/mcp/hezo-mcp-server)). A document is referenced by its plain filename -
for example `spec.md` - so links stay stable as the work evolves. Each document also carries
a short **description** - an overall one-or-two-sentence summary of what the document is and
when to read it, shown under its filename in the list and at the top of the document, so you
(and the next agent) can tell what a document is without opening it. It describes the
document's stable purpose, not a running list of its current contents, so it stays steady as
the document changes. Agents write the description when they create or update a document; you
can edit it inline from the document's **Edit** view. The document list sits
beside the reader, with a **search box** at the top that filters the list as you type and a
**+** button next to it for creating a new document - both stay in view while you scroll
the list. A **dropdown** next to the open document's title opens a name search from
inside the reader, so you can jump straight to another document without going back to the
list; it's hidden while you're editing. The reader's toolbar also has a **Download** button
that saves the open document to your device - as **Markdown** (`.md`, the original source)
or as **plain text** (`.txt`, with the Markdown formatting stripped). Download is available
on every surface you can read a document from, so a document you opened from a task thread
saves from right there.

Agents don't carry every document's full text on every run. Instead each run includes a
**manifest** - a table of contents listing each document's filename, its short
description, and when it last changed - and the agent opens the ones it needs with
`read_project_doc`. So adding or
updating a document immediately makes it discoverable to the whole team, without bloating
anyone's prompt. (Archived documents are left out of the manifest - see
[Archiving & deleting documents](#archiving--deleting-documents).)

## Archiving & deleting documents

Documents are retired by **archiving** - a reversible soft delete. An archived document
drops out of the default view, out of agents' listings and run manifests, and out of search
and autocomplete, but it keeps its filename, content, and full version history; existing
references to it keep resolving. Agents archive self-serve (it's the only way they can
"delete" - asking an agent to delete a document means it archives it), and you archive one
yourself from the **Archive** button in the document's toolbar. Archiving needs no
confirmation because nothing is lost.

The list in the rail shows **Active** documents by default; the **Active / Archived / All**
pills under the filter box switch views, each with a live count, and archived entries carry
an "Archived" chip. Opening an archived document shows a banner naming who archived it and
when, with a one-click **Restore**. While archived, a document is **read-only** - no edits,
status changes, or version restores until you restore it. (The repo-backed `AGENTS.md`
entry is a file in your repository, not a project document - it's always visible and can't
be archived.)

**Deletion is permanent and admin-only.** Agents can never delete a document. The Delete
action only appears on archived documents, so removing one for good is a deliberate
two-step: archive it, then delete it (with a confirmation).

## Reviewing documents

When you're reading a document - on the Documents page, in the task-sidebar preview, or in
its own tab - you can leave **review comments** on it, Google-Docs style. There are two
ways to comment:

- **Select any text** - a floating **Comment** button appears next to your selection; click
  it, write your feedback, and the selected text stays highlighted.
- **Hover a line** (on a pointer device) - a comment icon appears in the right margin;
  clicking it highlights the entire line and attaches your comment to it.

Each comment shows as an icon in the right margin, level with its highlighted text. Click a
highlight or its icon to **edit or delete** that comment. The review controls are grouped
together into their own **review toolbar** above the document - set apart from the document's
own edit and delete actions so the two don't get mixed up. Both the toolbar and those edit and
delete actions **stay pinned to the top while you scroll**, so they're always in reach in a long
document. The toolbar shows a comment count - **click the count to jump to the first comment** -
plus two actions: **action this review** (a clipboard button that opens a ready-made handoff you
can copy and paste into a task comment or a new task's description when assigning the work to an
agent - or post directly with the **Add to task** button, which opens a filterable list of the
project's tasks and adds the handoff to the one you pick as a comment; when you're reviewing a
document from a task's preview panel, that task is suggested first) and
**clear review** (a trash button that deletes every comment after confirmation), alongside a
**?** button that opens a short in-app guide to all of this. Posting a handoff onto a task
confirms with a link straight to the new task comment. The same review loop also covers the
files in the assets library - see [Reviewing assets](/docs/concepts/assets).

Wherever you read a document - the Documents page, the task-sidebar preview, or its own tab -
its header carries **Edit**, **History**, and **Download** buttons. On the two preview views
Edit and History take you to the document on the Documents page, ready to edit or with its
version history open, so you can move from a quick look straight into changing the document or
seeing how it changed. Download saves the copy from where you are, with no detour through the
Documents page. (Edit is hidden while a document is archived, since archived documents are
read-only.)

On a larger screen you can also **hide the document list** - the panel button just left of
the document's title collapses it, giving the document the full width of the page; the same
button brings the list back, and Hezo remembers your choice. (On a phone the list and the
document already take turns filling the screen.)

Agents read pending review comments directly: `read_project_doc` returns them alongside the
document content, each one anchored to the exact text you highlighted. So the flow is -
leave your comments, hand the review to an agent (pick the task from the **Add to task** list -
the task you're viewing comes first when you review from a task's document preview - or paste
the copied handoff into any task and assign it), and
the agent actions each comment against the document.

**A review applies to the current version of the document only.** Any update to the
document, whether you edit it or an agent does, automatically deletes all of its review
comments: the review is consumed by the revision that addresses it. Agents are told to
capture every comment before their first write and to make one consolidated update. Review
comments apply to project documents only - not to markdown files uploaded to the
[assets library](/docs/concepts/assets), and not to the repo-backed `AGENTS.md` entry on
the Documents page.

## Version history

At the top of every document a compact **details** banner shows, at a glance, when it was
created, when it last changed, and who last edited it - a person or a named agent.

Every change to a document is versioned, and each version carries a **changelog** - a short note
describing what changed and why. When an agent updates a document it writes that note as part of
the change, so the document body stays clean and current while the story of *how* it got there
lives in the history. (Agents are told to keep change logs out of the document itself and record
them here instead.)

Open a document's history from the **History** button in its toolbar. Every version is listed
newest-first, each shown like a comment - who made it, when, and its changelog with the same
@-mentions and document links you see everywhere else in Hezo. Select any version to view the
document exactly as it stood then; a banner across the top reminds you you're viewing an earlier
revision, with **View latest** to jump back. An older revision is read-only - review comments are
shown and can be added only on the current version.

**Restore** brings an earlier version back as the current one. It never rewrites history:
restoring adds a *new* version whose content matches the one you picked (with a changelog noting
the restore), so the full timeline, including whatever you restored past, stays intact.
Restoring is yours to do: agents can read and write documents, but only you can restore a version.

Because you and the agents write to the same documents, that history doubles as an audit trail -
you can see how a spec evolved and roll back a bad edit without losing the thread.

This **versioned-and-reversible** guarantee isn't limited to project documents. The same
applies to **agent system prompts** - every edit, including the
[learned rules the Coach adds](/docs/concepts/coach-and-self-improving-teams#every-change-is-reversible),
is snapshotted and restorable from the agent's settings - to a project's
[Custom Prompt](#custom-prompt), and to
[**skills**](/docs/concepts/skills#version-history--restore), your reusable how-to
(global or scoped to one project). Whatever your agents change, you can see what changed and put it back.

## Long-term chat memory

The CEO remembers your conversations **automatically** - you never have to tell it to remember
anything. The chatbox keeps recent messages live, up to a size cap. When the conversation grows
past that cap, the CEO summarizes the whole window into its **long-term memory** and the older
messages drop out of the live chat - so scrolling up tops out at what's still in the window. That
long-term memory is fed back into **every** chat turn, so the gist of past exchanges survives even
after the raw messages scroll away.

What it keeps is durable, standing knowledge - how you like things done ("always run a plan past
me before provisioning a team", "we deploy on Fridays"), decisions, and the gist of off-project
threads. Live data such as project lists and rosters is deliberately *not* memorised - that's
always read fresh from Hezo, so it can never go stale.

You can **review and edit** the long-term memory yourself on the CEO's **Chat history** tab (on
its agent page), so you can seed it with preferences up front or prune stale entries later. The
size of the live window (how much recent conversation is kept before it's compacted) is set
under **Settings → Chatbox**. See [Roles & the CEO](/docs/concepts/roles-and-coordination).

## Custom Prompt

Where the CEO's long-term chat memory steers the CEO, a project's **Custom Prompt** steers that project's workers.
The Custom Prompt is free-form **custom instructions applied to every agent in the project** -
house conventions, tone, standing do's and don'ts - set from the project's **Settings → Custom Prompt**
page and injected in full into each agent's prompt on every run. It's the lighter-weight choice when the
guidance applies to the whole roster rather than one role, and, like documents and system
prompts, every edit is **versioned and restorable**. You maintain it yourself, and your coordinating
agents (the CEO, the Coach, and the project's Captain) can update it too when a convention or lesson
should reach the whole team at once.

## Where each kind of knowledge goes

All of the above is memory, but each piece has a natural home - putting knowledge in the
right place is what keeps it findable and applied at the right moment:

- **Where one task stands right now** → that task's **progress summary**.
- **How a single task must be worked** (guardrails, required steps) → that task's
  **rules**.
- **What a task is and the domain context to do it** → that task's **description**.
- **Project-wide knowledge many tasks draw on** (the spec, the plan, the research) →
  a **project document**.
- **Reusable how-to** - a procedure an agent runs, not project state (how to use an MCP
  server, a release checklist, a house style); global or scoped to one project → a
  **[skill](/docs/concepts/skills)**.
- **A standing instruction for every agent in the project** → that project's **Custom Prompt**.
- **Your durable preferences for how the CEO works with you** → the CEO's **long-term chat
  memory** (kept automatically).

When in doubt, keep task-specific status in the summary, how-to-work constraints in the
rules, and anything the wider team will need again in a document or a skill.
