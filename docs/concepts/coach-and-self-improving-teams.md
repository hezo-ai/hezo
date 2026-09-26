---
title: The Coach & self-improving teams
order: 11
section: Concepts
---

# The Coach & self-improving teams

A Hezo team gets better the more it ships, because the **Coach** turns its finished work into
durable lessons. The Coach is a global agent with no other job: it reads a task after the fact
and writes what it learned into the system prompts of the agents involved, so the same mistake
doesn't happen twice.

## What the Coach is

The **Coach** is one of two global roles that live in
[HQ](/docs/concepts/projects-and-teams#hq---the-home-team) (the other is the
[CEO](/docs/concepts/roles-and-coordination#the-ceo)). There is exactly one Coach for the
whole instance, it isn't a member of any single project team, and it reports to you, the
admin. Unlike a worker, it doesn't pick up tasks, write features, or review code; its job is
organisational learning. It makes two kinds of pass: a **task review** after one task is
completed, and a **retrospective** over one project's recent work.

The Coach's behaviour comes from its
[system prompt](https://github.com/hezo-ai/hezo/blob/main/agents/_instance/coach.md).

## How the loop works

Every task already records how the work went: the comment thread and the back-and-forth in
it, any rejections or rework, and what each agent actually did (see
[Tasks, rules & summaries](/docs/concepts/tasks)). The Coach reads that record after the fact
and looks for patterns in it.

1. **A task is completed.** When a task is marked **Done** - in any project, in any
   team - the Coach is woken automatically with that task's full history. If that wake is ever
   missed, the Coach picks the task up on its own heartbeat, so a completed task is not left
   unreviewed. The one exception is a team coherence review: it checks the Coach's own prompt
   changes, so the Coach does not review it.
2. **It reviews the whole thread.** The Coach reads the comments and the agents' work
   end to end, noting where the work went wrong: work that got sent back, an agent that
   received corrective feedback or made a wrong assumption, an approach that was tried and
   abandoned, or a communication breakdown that cost time. When the comments don't tell the
   whole story, it can also read an agent's **run logs**, the actual output from the agent's
   container, to see what happened rather than only what was reported.
3. **It captures the lessons.** For each pattern worth learning from, the Coach figures
   out which agent (or agents) should learn from it and writes a concise, generalisable
   **learned rule** into their system prompt. It updates *everyone* involved in the
   feedback loop, not just the agent that got the direct pushback. When a lesson applies to
   the whole roster, it can write it into the project's
   [Custom Prompt](/docs/concepts/documents-and-memory#custom-prompt) instead of every agent's prompt.
4. **It closes the loop.** The Coach leaves a short summary comment on the task noting
   what it changed (or that the task went smoothly and needed nothing). The task stays
   in its final **Done** state - the Coach reviews it but does not change its status.

The review runs in the background at the very end of the task lifecycle, so you don't have to
trigger it or wait on it.

## The retrospective

Some problems are invisible one task at a time. A team can look healthy in every single
review and still be going in circles: the same work re-filed under a new title each week,
one task spawning a dozen children that spawn a dozen more, a folder of documents nobody
will read again. Every task passes; the pattern is only in how they add up.

So the Coach also makes a second pass. Every couple of days it takes one project and reads
the shape of its recent work rather than the work itself: where the effort went, what
spawned what, which tasks look like each other, and what the team produced. Those are
counted for it, so the judgement is about the numbers rather than about reading everything
again.

- **It reports at most three findings, worst first.** A busy project is not a finding. A
  quiet week is the expected outcome, and the Coach says so and stops.
- **A finding is one comment on the task it is about**, tagging you. Tagging you is also what
  raises the inbox item, so the finding reaches you wherever you already look.
- **The task stops being picked up until you answer.** A finding says work is not
  converging; letting that work carry on while the question sits unread would be the same
  week over again. Replying releases it, and so does **Run now**.
- **It gives you counts and shares**, not totals - "31 runs in 17 hours", "70% of the
  documents here were made this week" - because those are the figures you can act on.
- **It does not repeat itself.** Something an earlier retrospective raised is not raised
  again unless the figures have got materially worse.

A retrospective changes no prompts. It infers from aggregates, and a lesson worth writing
into an agent comes from what someone actually said - which is the task review's job.

A project nobody has worked in is skipped entirely, so a quiet project costs nothing.

## Learned rules

A **learned rule** is a short, specific instruction the Coach adds to an agent's
system prompt - collected together in a dedicated *Learned Rules* section so they're easy
to find. A rule is a generalisable lesson ("always confirm the target environment before
running a migration"), never a one-off fix for a single task.

The Coach is deliberately conservative about what it writes:

- **Only durable, generalisable lessons** - patterns, not isolated incidents.
- **Learned Rules only** - it adds, merges and removes rules in that section, and never
  rewrites or removes the agent's own instructions.
- **Rules earn their place** - a rule that adds a check says what the check costs. When a
  rule adds work to a task without catching a problem, the Coach marks it with that task. It
  removes the rule when this happens again on a different task, and clears the mark when the
  rule catches a problem. Each agent holds at most 20 learned rules. Hezo refuses a change
  that would take an agent past 20, and an agent already past 20 can only be trimmed, so the
  Coach merges or removes a rule before it adds another.
- **Rule changes stay small** - a change to an agent's learned rules alone does not start a
  team coherence review, because the agent's own instructions are unchanged.
- **No duplicates** - it reads an agent's current prompt first and skips anything already
  covered.
- **When in doubt, it skips** - a false lesson is worse than a missed one, and a task
  that went cleanly gets no new rules.

Because learned rules are additions to the system prompt, they behave exactly like the
prompts you write by hand: they take effect on the agent's next run, and they are visible and
editable from the agent's settings (see
[Hiring & customizing agents](/docs/concepts/hiring-and-agents#editing-system-prompts)).

### Every change is reversible

Each update the Coach makes records a **revision snapshot**, so you can review what
changed and **roll back** any edit from the agent's settings page if you disagree with it.

## Beyond prompts: docs and skills

System prompts are the Coach's main lever, but not its only one. When a review turns up a
reusable procedure, a team convention, or a project document that's gone stale or missing, the
Coach can also update a **project document** or create a **skill** for that team, whichever
fits the lesson. See [Documents & memory](/docs/concepts/documents-and-memory).

## Why this matters

Every completed task can add a rule to the agents that worked on it, so an agent that got
pushback once carries the correction into its next run, and a convention learned the hard way
gets written down instead of rediscovered. None of that asks you to hand-tune a prompt after
every misstep, and you keep the final say through approvals and rollbacks.
