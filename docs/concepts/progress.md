---
title: Progress & project status
order: 10.4
section: Concepts
---

# Progress & project status

**Progress** is your standing answer to "where does this project actually stand?" - written by the
**Captain**, kept current on its own, and readable in about ten seconds. Every project has one.
You don't have to configure anything, and you don't need to set a goal first.

It lives on the project's **Dashboard**, the page the project menu opens on. There is no separate
Progress page: the summary is the second band on the dashboard, directly under the metrics, and the
work it describes is listed beneath it.

## The summary

A short markdown blurb of where the project stands: what has taken place, and what is being
planned. It leads with the key points in **bold** and opens collapsed to just that lead line; use
**Show more** for the full narrative.

The summary deliberately **names no individual tasks**. It is the altitude view - the paragraph you
would give someone who asked how the project is going - and the lists on the same page are where
the specific work lives, each row already a link. A summary that listed task numbers would be a
backlog, not a summary.

There is nothing to edit by hand. Each time the Captain runs a progress update it reviews the
project and rewrites the summary; the **Updated** time shows when that last happened.

## What else the dashboard carries

Reading down the page:

- a **metric strip** - what needs you, how many agents are working, open tasks, goal progress and
  month-to-date spend,
- the **progress summary** above,
- a strip naming the agents **working right now** and the task each is on,
- **action items** waiting on you, and the tasks **in progress**,
- your [**goals**](/docs/concepts/goals) and your **spend**,
- the **progress update runs** that produced the summary.

The goals card shows the four goals most worth a decision - off track first, then at risk - with a
link to the rest. The in-progress list shows the seven most recently touched tasks, with a link to
the full list.

## Progress update runs

A **progress update** is a standalone Captain run - no task attached - that exists to rewrite the
summary. The run history sits at the bottom of the dashboard, each entry expandable to its full
log, exactly like an agent run on a task.

The Captain runs one on its own **heartbeat** when the summary has gone stale and something has
actually moved since it was last written. A project nobody is working on doesn't burn runs
rewriting an identical summary.

You don't have to wait for that: **Run now** triggers a progress update immediately. It always
runs, whether or not the project has goals. If the Captain is busy, the run is **queued** and
starts as soon as it frees up; a queued run shows as a "Queued - waiting for the Captain to finish"
row you can cancel while it waits.

## Goals are optional on top

If you also set [**goals**](/docs/concepts/goals), the same progress update assesses whichever ones
are due, and the dashboard's goals card fills in with each one's progress, health and deadline.

Goals are **not required**. The progress summary works exactly the same without them - goals add
outcome tracking on top, and they are well worth adding, but the summary does not wait for them.

> Progress is a per-project concept. The global **HQ** project has no progress summary.
