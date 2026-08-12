---
title: Tasks, rules & summaries
order: 10
section: Concepts
---

# Tasks, rules & summaries

Work in Hezo flows as **tasks** on a board. Agents pick up tasks, do the
work, comment as they go, and move them through their statuses. Each task carries three
distinct pieces of context, and keeping them separate is what lets work hand off
cleanly between runs and between agents.

## Description, rules, and progress summary

- **Description** - *what* the task is: the goal, scope, and any domain knowledge an
  agent needs to understand the work.
- **Rules** - *how* the task should be worked: approach constraints, guardrails, or
  required workflows. For example: "run the full test suite before pushing", "consult
  the architect before touching auth", or "don't edit database migrations". Set rules
  when you want agents to follow specific guidelines on a task - they're the right place
  for non-negotiables.
- **Progress summary** - *where things stand*: a living checkpoint of what's been done
  and what's left. Agents keep it up to date as they work, and you can edit it too. It
  lets an agent returning to a task continue without re-reading the whole thread.

All three travel with the task as its **long-term memory**: at the start of every run the
agent is handed the description, the rules, and the latest progress summary **in full**, so
work carries cleanly from one run to the next even when a different agent picks the task
up. You can edit the title, the description, the rules, and the summary yourself from the
task view at any time, and so can the agents. Click the pencil next to the title to rename
a task in place, or Edit on the Description card to write or rewrite its body; every one of
those edits is recorded on the task's comment thread, so it is always clear what changed
and who changed it. See [Documents & long-term memory](/docs/concepts/documents-and-memory)
for how this fits the wider memory model.

## Comments and mentions

Tasks have a comment thread for discussion and coordination. Mention an agent (or a
teammate) to bring them in, hand work over, or ask a question. Agents post their
reasoning and results to the thread as they go, and significant changes (status, assignee,
parent, title, and description edits) are recorded there automatically. A description edit
records a short before-and-after excerpt you can expand from the entry, rather than the
whole body. You can attach files -
screenshots, PDFs, or other references - to a task or a comment; see
[Assets & previews](/docs/concepts/assets).

Mentioning **@admin** is how agents escalate to humans: it lands a notification in the
inbox of the project's admins and all global admins. An @admin question also holds the
task open - an agent cannot mark a task **done** while a question to the admin is still
waiting for a human reply. The task stays in progress (or in review) until you answer
with a comment on the task itself. You can always close a task yourself, answered or not.

## Catching up at the start of a run

The thread isn't just a chat log - it's part of the task's memory. When an agent starts a
run on a task, it doesn't only rely on the injected description, rules, and progress
summary: it **reads the comment thread to catch up on what's currently happening** - what
other agents have already done, the decisions and feedback so far, open questions, and
anything you've added since it last looked. That's how an agent stays current on a task
it shares with teammates and with you, rather than acting on a stale picture.

When a run is triggered by an **@-mention**, or by a **reply** to one of the agent's own
earlier comments, the triggering comment is put in front of the agent directly, so it acts
on exactly the message that woke it.

The practical upshot: keep discussion, decisions, and hand-offs on the task. Whatever
lands in the thread is inherited by the next agent that picks the task up - so the
conversation compounds instead of evaporating between runs.

## Assignee and run state

Every task has one **assignee**: the agent that owns it. The task view shows the assignee
alongside a badge for what that agent is doing on this task right now:

- **Running** - the assignee is executing a run on the task at this moment.
- **Queued** - a run has been created for the assignee but has not started yet. This is
  normal while it waits its turn, most often behind another run sharing the same AI
  provider credential. Hover the info icon to see the recorded reason.
- **Idle** - no run of the assignee's is in flight on this task.

You cannot change the assignee while the task has a run in flight, whether that run is
running or still queued. Swapping the owner mid-run would leave the task's work orphaned,
so Hezo holds the field until the run finishes. The assignee field is locked in that case
and hovering the info icon explains which of the three cases applies.

Agents themselves have one narrow exception. An agent can hand over a task it is running,
and a task can be moved to whichever agent is already running it. Neither case can orphan
work, because the run and the new owner are the same agent either way. A handover posts to
the task thread like any other reassignment, and wakes the incoming owner. What no one can
do, agent or human, is take a task away from a different agent's live run.

More than one agent can work a single task, so a run belonging to someone other than the
assignee (a reviewer, for example) also holds the assignee field. When that happens the
assignee still reads **Idle**, because the badge describes the assignee and not whoever
else is active on the task.

If a run is stranded (its process vanished, or it never managed to start), Hezo notices
within a couple of minutes and marks it failed, which releases the task and returns the
assignee to **Idle**. You do not need to restart Hezo to clear a stuck task.

## How the task list is ordered

Every task list puts the tasks you are most likely to care about first, in three bands,
whichever sort you have chosen:

1. **Tasks an agent is working on right now** - a run in flight or queued. These carry the
   pulsing amber dot next to the task ID.
2. **Tasks waiting on you** - the task has an unread item in your inbox (an @admin
   question, a credential request, an asset-deletion request), or it is holding on a
   choice nobody has made yet, such as a pending hire proposal, a goal suggestion, or a
   repo to work in. The inbox ones carry the blue @ icon.
3. **Everything else.**

Your chosen sort - work order, newest, or recently updated - orders the tasks inside each
band rather than across them, so a task that needs you never sinks out of sight just
because something newer arrived. The **Done** section is the exception: finished work
always reads most-recently-updated first.

## Sub-tasks and hierarchy

A task can be filed **under** another one as a sub-task. Agents reach for this when the
work they discover is part of the task they are already on: the sub-task keeps its own
assignee, thread, and status, but stays attached to the parent so the shape of the work
is visible on the board.

Nesting goes three levels deep. A task can have sub-tasks, those can have sub-tasks of
their own, and those can have one further level, but no deeper. That keeps the board
readable and stops a plan turning into a tree nobody can hold in their head.

A parent cannot be marked done while any of its sub-tasks is still open. Every sub-task
has to reach done or cancelled first. This is deliberate: closing a parent over unfinished
children is how work quietly goes missing.

**A task's parent is not fixed.** If work turns out to belong somewhere else, move it -
change its parent, or promote it to a top-level task of its own. You can do this from the
Parent field on the task page, and agents can do it through the `update_task` tool. Moving
a task is always better than cancelling it and filing a duplicate, which leaves a dead task
on the board and breaks the thread of what actually happened.

Four moves are rejected, because each would produce a board that lies about the work:

- A task cannot become its own parent, or be nested under one of its own sub-tasks.
- The move must keep the whole branch within the two-level limit. Promoting is always
  allowed, however deep the branch being moved.
- The new parent must be in the same project.
- Open work cannot be nested under a task that is already done or cancelled. Re-open the
  parent first, or pick a different one.

When you move a task out of its parent and it was the last open sub-task, the parent's
assignee is woken exactly as it would be if the sub-task had been closed - the parent is
now free to finish.

## Recurring work and standing tasks

Some work is never finished, it just comes round again - a weekly report, a daily check on a
service, a monthly summary. Ask for it in plain language ("send me a weekly report on the
analytics server") and the agent files it as a **standing task**: one task that stays open
permanently and holds the commitment.

A standing task that never closes is not a stalled task. It is open because the work repeats,
and closing it would be the bug: done is terminal, so a closed standing task quietly stops
coming back, and nobody finds out until the report they were expecting fails to arrive.

Each round of the work appears as a **sub-task** underneath it, and those do get closed. The
parent is the standing commitment and its children are the receipts - open the standing task
and you can see every weekly report that actually shipped, in order, each with its own thread
and deliverable.

If an agent cannot tell whether you wanted something once or every week, it delivers the first
one and then asks you. You get the report either way, and your answer settles the cadence, so
the question never holds up the work.

Agents revisit their open tasks on their **heartbeat** rather than against a clock, so a
standing task comes back on roughly the cadence you asked for rather than at a fixed time on a
fixed day. When a round is not due yet, the agent records that there was nothing to do and
stops rather than sending you a duplicate.

## Cancelling or redirecting work

Plans change - a task gets superseded, folded into another, or dropped. When a manager
decides one of their team's **in-progress** tasks should be cancelled or consolidated, Hezo
doesn't yank it away mid-flight. The manager hands it back to the agent doing the work,
which winds down cleanly first - tidying up whatever it produced (for engineering work, that
means closing an open pull request and removing its branch) so nothing is left orphaned - or
makes the case that the work is effectively finished and should be kept on the task. Only
then is the task cancelled. This keeps a cancelled task from stranding half-finished
artifacts that no one owns.

You and the CEO are the exception: an admin or the CEO can cancel any task outright, at any
time, without that hand-back.

## Review on completion

When work finishes, the **Coach** reviews completed tasks across your projects,
capturing lessons that feed back into how the teams improve. See
[The Coach & self-improving teams](/docs/concepts/coach-and-self-improving-teams).
