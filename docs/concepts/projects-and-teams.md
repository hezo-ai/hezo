---
title: Projects & teams
order: 6
section: Concepts
---

# Projects & teams

## One project, one team

A **project** is the primary unit of work in Hezo, and every project owns exactly one
**team** — its roster of agents. The relationship is one-to-one: a team backs a single
project. You don't manage teams separately; you reach a team through its project.

This keeps things clean: a project's agents, tasks, budget, container, and connections
all belong to that project and nothing leaks between them.

## Team templates

When you create a project you choose a **template**, which decides the starting roster:

- **Blank** — just a Captain. The minimal baseline; hire roles as you need them.
- **Software development** — a Captain plus a full delivery roster (for example an
  architect, engineers, QA, a designer, and supporting roles).
- Other templates for different kinds of work.

Every template gives the team a **Captain** to lead it. The instance-wide CEO and Coach
are never part of a template — they live in HQ (below).

## Reusing a team setup

Spent time tuning a team — its roles, prompts, and connections — and want the same
starting point again? You don't have to rebuild it:

- **Save a team as a template** so it shows up as a reusable option for future
  projects, or
- **Start a new project directly from an existing team**, which snapshots that team's
  roster as the new project's starting point.

Either way the new project gets its own independent team — changes to one never affect
the other.

## HQ — the home team

**HQ** is the one special, instance-wide team. It's the permanent home of the two roles
that work across every project — the **CEO** and the **Coach** — and it's where
instance-level settings live (model providers, shared connections, and the like). HQ is
also where you [chat with the CEO](/docs/concepts/roles-and-coordination#chatting-with-the-ceo):
when you talk to it to create a new project or check in on any team, you're talking to the
CEO in HQ. See [Roles & the CEO](/docs/concepts/roles-and-coordination).

## Next

- [Roles & the CEO](/docs/concepts/roles-and-coordination) — who does what.
- [Hiring & customizing agents](/docs/concepts/hiring-and-agents) — change a team's
  roster and behaviour.
