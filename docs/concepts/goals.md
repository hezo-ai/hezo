---
title: Goals & progress
order: 10.5
section: Concepts
---

# Goals & progress

**Goals** are the high-level objectives a project is working toward. Where tasks are the
individual pieces of work on the board, goals are the outcomes those tasks add up to — and
they give you, the admin, a way to see how far along a project is and where things stand
**without micromanaging the board.**

You set the goals; the **Captain** keeps them up to date. You don't have to remember to
update a status or move a slider — the Captain re-checks each goal on a schedule and writes
a fresh estimate, so the **Progress** page is always a current read on the project.

## The Progress page

Open **Progress** in the project menu (just under **Inbox**). Top to bottom it shows:

- a **project progress summary** the Captain keeps current — a short blurb of what's done,
  what's in progress, and what's still to do. It opens collapsed (showing the Captain's
  headline points); expand it for the full narrative, which may link a few key tasks.
- your **goals**, each as a panel showing its progress, health, and latest status. Click a
  panel to open the goal's own page, where its full progress chart and history live.
- the recent **progress update runs** for the project, with a **Run now** button to trigger one
  on demand.

## Setting a goal

From the **Progress** page choose **Create Goal** (or the **New goal** card shown alongside your
goals). A goal has:

- **Goal name** — the objective in a line (e.g. "Reach 100 active customers").
- **Measurement** — the precise definition of *how you'll know the goal is achieved* (e.g.
  "100 active paid subscriptions in Stripe"). This is the bar the Captain measures against, so
  the more concrete it is, the more honest its progress estimates.
- **Suggested actions** *(optional)* — guidance on what the Captain should do or check toward
  the goal: specific checks, or a standing instruction like "run a weekly cron-style review of
  the signup funnel". Leave it blank to let the Captain decide.
- **Deadline** *(optional)* — when the goal should be met. The Captain weighs progress against
  this date when it sets the goal's health, and once the deadline has passed the goal is checked
  on every heartbeat — regardless of its check frequency — until it's met or archived.
- **Check frequency** — how often the Captain re-assesses the goal: **daily** (the default),
  **weekly**, or **monthly**.

The create and edit forms keep the **SMART** framework (Specific, Measurable, Achievable,
Relevant, Time-bound) in front of you as a reminder. A project can have any number of goals;
until you've set one, a gentle dot pulses next to **Progress** in the menu as a nudge to create
your first. Editing a goal — from the goal's own page or the panel's edit control — reopens the
same form.

## How the Captain tracks progress

On the Captain's heartbeat, it looks at which goals are **due** for a check and runs a single
**progress update** covering all of them at once. A goal is due when its **check frequency** has come
round (last checked longer ago than its cadence, or never checked) **or** once its **deadline**
has passed — a goal past its deadline is always checked and never skipped while it stays active.
Goals that aren't due on either count are skipped. For each due goal the Captain assesses real
progress toward the outcome — reading the relevant tasks, comments, and project state rather than
just counting finished tasks — and records three things:

- a **progress percentage** (0–100) — its honest estimate of how far along the goal is,
- a **health** — a coloured pill that reads at a glance: **on track** (green), **at risk**
  (amber), or **off track** (red); a brand-new goal shows **not assessed** (grey) until its
  first check,
- a **status blurb** — a short paragraph on where the goal stands and what's needed next.

Because each check is recorded, every goal shows a **progress chart** of how its percentage
has moved over time, so you can see momentum (or a stall) at a glance.

These progress updates are **not** done inside a task — they're standalone Captain runs. The recent
progress update runs for the whole project appear at the bottom of the **Progress** page. Each goal's
own page also has a **Progress update runs** section showing just the runs that did something for
*that* goal — the progress it set and any tasks it created or commented on toward the goal show
inline, and each run expands to reveal the status summary it recorded.

You don't have to wait for the schedule: the **Run now** button next to **Progress update runs** on
the Progress page triggers a progress update immediately. It runs the same check the heartbeat would —
assessing whichever goals are currently due — so if nothing is due yet it simply reports that.

During the same run the Captain also refreshes the **project progress summary** shown at the top
of the Progress page, so that headline stays in step with the goal estimates.

## Archiving

The Progress page defaults to an **Active** view and has an **Archived** filter to see the rest.
Archiving a goal (from its edit/archive control) sets it aside without deleting it: an archived
goal is **no longer checked** — the Captain skips it entirely and never updates its status or
files work for it. Unarchive it any time to bring it back into rotation.

## Goals and the board

When the Captain decides a goal needs a push, it either **comments on an existing in-flight
task** to steer or unblock it, or **files new tasks** through the normal delegation flow and
links them to the goal. But it doesn't create work for its own sake: if tasks already in the
backlog or in flight will advance the goal, the Captain leaves the board alone. The point of a
progress update is to judge whether the project is on course — not to manufacture busywork every
time a goal comes due. The Captain never re-opens a closed task; if something needs redoing it files
a fresh task that points back at the original.

The estimate is exactly that — an estimate, made by the Captain. Treat the **blurb** as the
primary signal and the **percentage** as a quick gauge of direction. Together they let you
glance at a project and know where it's headed without reading every task.

> Goals are a per-project concept. The global **HQ** project does not have goals.
