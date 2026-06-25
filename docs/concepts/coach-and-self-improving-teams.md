---
title: The Coach & self-improving teams
order: 10
section: Concepts
---

# The Coach & self-improving teams

Most agent setups stay exactly as good as the day you wrote their prompts. Hezo teams
don't: they get better the more they ship. That improvement loop is run by the **Coach** —
an instance-wide agent whose only job is to turn finished work into durable lessons, so
the same mistake doesn't happen twice.

## What the Coach is

The **Coach** is one of two instance-wide roles that live in
[HQ](/docs/concepts/projects-and-teams#hq--the-home-team) (the other is the
[CEO](/docs/concepts/roles-and-coordination#the-ceo)). There is exactly one Coach for the
whole instance, it isn't a member of any single project team, and it reports to you — the
admin. Unlike a worker, it doesn't pick up tasks, write features, or review code. Its sole
purpose is **organisational learning**: reviewing how completed tickets actually went and
improving the agents involved.

The Coach's behaviour comes from its
[system prompt](https://github.com/hezo-ai/hezo/blob/main/agents/_instance/coach.md).

## How the loop works

Every ticket already carries a rich record of how the work went — the comment thread,
the back-and-forth, any rejections or rework, and what each agent actually did (see
[Tasks, rules & summaries](/docs/concepts/tasks)). The Coach reads that record after the
fact and mines it for patterns.

1. **A ticket is completed.** When a task is marked **Done** — in any project, in any
   team — the Coach is woken automatically with that ticket's full history. It also runs
   on its own heartbeat to catch any completed tickets that slipped through.
2. **It reviews the whole thread.** The Coach reads the comments and the agents' work
   end to end, looking for the moments that matter: work that got sent back, an agent that
   received corrective feedback or made a wrong assumption, an approach that was tried and
   abandoned, or a communication breakdown that cost time.
3. **It captures the lessons.** For each pattern worth learning from, the Coach figures
   out which agent (or agents) should learn from it and writes a concise, generalisable
   **learned rule** into their system prompt. It updates *everyone* involved in the
   feedback loop, not just the agent that got the direct pushback.
4. **It closes the loop.** The Coach leaves a short summary comment on the ticket noting
   what it changed (or that the ticket went smoothly and needed nothing), and the ticket
   moves to its final, **Closed** state.

This sits at the very end of the task lifecycle: **Done** means the work is approved and
landed; **Closed** means the Coach has done its post-mortem. The review happens in the
background — you don't have to trigger it or wait on it.

## Learned rules

A **learned rule** is a short, specific instruction the Coach appends to an agent's
system prompt — collected together in a dedicated *Learned Rules* section so they're easy
to find. A rule is a generalisable lesson ("always confirm the target environment before
running a migration"), never a one-off fix for a single ticket.

The Coach is deliberately conservative about what it writes:

- **Only durable, generalisable lessons** — patterns, not isolated incidents.
- **Additive only** — it appends new rules and never rewrites or removes an agent's
  existing instructions.
- **No duplicates** — it reads an agent's current prompt first and skips anything already
  covered.
- **When in doubt, it skips** — a false lesson is worse than a missed one, and a ticket
  that went cleanly gets no changes at all.

Because learned rules are just additions to the system prompt, they behave exactly like
the prompts you write by hand: they take effect on the agent's next run and are fully
visible and editable from the agent's settings (see
[Hiring & customizing agents](/docs/concepts/hiring-and-agents#editing-system-prompts)).

### Every change is reversible

Each update the Coach makes records a **revision snapshot**, so you can review what
changed and **roll back** any edit from the agent's settings page if you disagree with it.
The Coach is automating prompt-tuning, but you stay fully in control of every agent's
instructions.

## Beyond prompts: docs and skills

Improving system prompts is the Coach's main lever, but not its only one. When a
retrospective surfaces a reusable procedure, a team convention, or a project document
that's gone stale or missing, the Coach can also update a **project document** or create a
**skill** for that team — lifting the team's productivity in whatever form fits the lesson
best. See [Documents & memory](/docs/concepts/documents-and-memory).

## Why this matters

The result is a team that compounds. Each shipped ticket isn't just a finished piece of
work — it's a data point that makes the next ticket go a little smoother. Agents stop
repeating the mistakes that earned them pushback, conventions that were learned the hard
way get written down, and the whole roster sharpens over time **without you hand-tuning
prompts after every misstep**. You keep the final say through approvals and rollbacks; the
Coach does the steady, unglamorous work of making sure the team learns from itself.
