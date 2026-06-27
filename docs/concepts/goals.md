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
a fresh estimate, so the Goals page is always a current read on the project.

## Setting a goal

Open **Goals** in the project menu (above Tasks) and choose **Create Goal**. A goal has:

- **Goal name** — the objective in a line (e.g. "Reach 100 active customers").
- **Measurement** — the precise definition of *how you'll know the goal is achieved* (e.g.
  "100 active paid subscriptions in Stripe"). This is the bar the Captain measures against, so
  the more concrete it is, the more honest its progress estimates.
- **Suggested actions** *(optional)* — guidance on what the Captain should do or check toward
  the goal: specific checks, or a standing instruction like "run a weekly cron-style review of
  the signup funnel". Leave it blank to let the Captain decide.
- **Deadline** *(optional)* — when the goal should be met. The Captain weighs progress against
  this date when it sets the goal's health.
- **Check frequency** — how often the Captain re-assesses the goal: **daily** (the default),
  **weekly**, or **monthly**.

The create and edit forms keep the **SMART** framework (Specific, Measurable, Achievable,
Relevant, Time-bound) in front of you as a reminder. A project can have any number of goals;
until you've set one, a gentle dot pulses next to **Goals** in the menu as a nudge to create
your first.

## How the Captain tracks progress

On the Captain's heartbeat, it looks at which goals are **due** for a check (based on each
goal's frequency) and runs a single **goal check** covering all of them at once. Goals that
aren't due yet are skipped. For each due goal the Captain assesses real progress toward the
outcome — reading the relevant tickets, comments, and project state rather than just counting
finished tasks — and records three things:

- a **progress percentage** (0–100) — its honest estimate of how far along the goal is,
- a **health** — a coloured pill that reads at a glance: **on track** (green), **at risk**
  (amber), or **off track** (red); a brand-new goal shows **not assessed** (grey) until its
  first check,
- a **status blurb** — a short paragraph on where the goal stands and what's needed next.

Because each check is recorded, every goal shows a **progress chart** of how its percentage
has moved over time, so you can see momentum (or a stall) at a glance.

These goal checks are **not** done inside a task — they're standalone Captain runs. The list
of recent goal checks appears at the bottom of the Goals page, each noting which goals it
updated (or that nothing changed).

## Archiving

The Goals page defaults to an **Active** view and has an **Archived** filter to see the rest.
Archiving a goal (from its edit/archive control) sets it aside without deleting it: an archived
goal is **no longer checked** — the Captain skips it entirely and never updates its status or
files work for it. Unarchive it any time to bring it back into rotation.

## Goals and the board

When the Captain decides a goal needs work to move forward, it files the tickets through the
normal delegation flow and links them to the goal. But it doesn't create work for its own
sake: if tickets already in the backlog or in flight will advance the goal, the Captain
leaves the board alone. The point of a goal check is to judge whether the project is on
course — not to manufacture busywork every time a goal comes due.

The estimate is exactly that — an estimate, made by the Captain. Treat the **blurb** as the
primary signal and the **percentage** as a quick gauge of direction. Together they let you
glance at a project and know where it's headed without reading every ticket.

> Goals are a per-project concept. The instance-wide **HQ** project does not have goals.
