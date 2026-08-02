---
title: Progress & project status
order: 10.4
section: Concepts
---

# Progress & project status

**Progress** is your standing answer to "where does this project actually stand?" - written by the
**Captain**, kept current on its own, and readable in about ten seconds. Every project has one.
You don't have to configure anything, and you don't need to set a goal first.

Open **Progress** in the project menu (just under **Inbox**). Top to bottom it shows:

- the **project progress summary** - the high-level read,
- three columns of **recent task activity** - the specific work,
- the **progress update runs** that produced all of it.

## The summary

A short markdown blurb of where the project stands: what has taken place, and what is being
planned. It leads with the key points in **bold** and opens collapsed to just that lead line; use
**Show more** for the full narrative.

The summary deliberately **names no individual tasks**. It is the altitude view - the paragraph you
would give someone who asked how the project is going - and the columns directly beneath it are
where the specific work lives, each row already a link. A summary that listed task numbers would be
a backlog, not a summary.

There is nothing to edit by hand. Each time the Captain runs a progress update it reviews the
project and rewrites the summary; the **Updated** time shows when that last happened.

## The three columns

Beneath the summary, up to five tasks each:

- **Recently actioned** - what is being worked on right now.
- **Recently created** - what has just been filed, and why.
- **Recently closed** - what has just been finished.

Each row shows the task's identifier and title, and underneath it **a one-line summary the Captain
wrote for that task** during its last progress update. These lines are not copied from the task -
they are written to answer *what does this mean for the project*: what was accomplished, what is
being accomplished, or what is outstanding. Read the three columns top to bottom and you should
come away knowing where things stand.

Click any row to open that task.

On a phone the three columns become a **tab strip** - Actioned / Created / Closed - with the count
on each tab, so nothing is hidden without saying how much is behind it.

> The columns are a snapshot from the last progress update, not a live feed. A task created a
> minute ago appears once the next progress update runs.

## Progress update runs

A **progress update** is a standalone Captain run - no task attached - that exists to rebuild this
page. The run history sits at the bottom of the Progress page, each entry expandable to its full
log, exactly like an agent run on a task.

The Captain runs one on its own **heartbeat** when the page has gone stale and something has
actually moved since it was last written. A project nobody is working on doesn't burn runs
rewriting an identical summary.

You don't have to wait for that: **Run now** triggers a progress update immediately. It always
runs, whether or not the project has goals. If the Captain is busy, the run is **queued** and
starts as soon as it frees up; a queued run shows as a "Queued - waiting for the Captain to finish"
row you can cancel while it waits.

## Goals are optional on top

If you also set [**goals**](/docs/concepts/goals), the same progress update assesses whichever ones
are due, and the Progress page grows a **goal indicator** in the summary header: one bar per goal,
filled to its own progress and coloured by its health, with the overall percentage beside it. Click
it to open the Goals page.

Goals are **not required**. Progress summaries and the activity columns work exactly the same
without them - goals add outcome tracking on top, and they are well worth adding, but the Progress
page does not wait for them.

> Progress is a per-project concept. The global **HQ** project does not have a Progress page.
