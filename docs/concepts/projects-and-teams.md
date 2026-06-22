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

When you create a project you choose a **template**, which decides the starting roster.
Every template gives the team a **Captain** to lead it. The instance-wide CEO and Coach
are never part of a template — they live in HQ (below).

Hezo ships with two built-in templates. Each agent's behaviour comes from a **system
prompt** that you can read (and, once hired, customise — see
[Hiring & customizing agents](/docs/concepts/hiring-and-agents)). The links below point
at the source prompt for each role.

### Blank team

Just a **Captain** — the minimal baseline. Hire roles as you need them.

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/blank/captain.md) — leads
  the team, turns the brief (and any attached [project plan](#the-project-plan-document))
  into an execution plan, and escalates to the CEO. Because the team starts with only the
  Captain, this Captain produces a plain **project plan** rather than a formal product
  requirements document (PRD).

### Software development team

A **Captain** plus a full delivery roster:

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/captain.md) —
  leads the team, breaks the goal into tickets, and coordinates delivery.
- [Architect](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/architect.md) —
  technical vision, specs, and architecture decisions; gates and schedules the deploy.
- [Product Lead](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/product-lead.md) —
  owns scope and requirements; turns the brief (and any attached project plan) into the
  formal **PRD**.
- [Engineer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/engineer.md) —
  implementation, tests, and code.
- [QA Engineer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/qa-engineer.md) —
  testing, code quality, and the final approval gate.
- [Security Engineer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/security-engineer.md) —
  security review, threat modelling, and vulnerability analysis.
- [UI Designer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/ui-designer.md) —
  visual and interaction design, component architecture, and HTML mockups.
- [DevOps Engineer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/devops-engineer.md) —
  infrastructure, CI/CD, and staging/production deployment.
- [Marketing Lead](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/marketing-lead.md) —
  marketing strategy, content, public documentation, and launch.
- [Researcher](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/researcher.md) —
  competitive analysis, technical research, and feasibility studies.

## The project plan document

When you create a project you can optionally attach a **project plan document** — a
fuller brief than the description field, describing what the project is for: goals,
scope, context, and constraints. It's saved into the project's docs as `project-plan.md`
and the Captain is told to use it as the starting point for planning.

How it's used depends on the team:

- On a **software development** team, the project plan is the input the Product Lead turns
  into the formal PRD, which then feeds the spec and implementation work.
- On a **blank** (or other non-software) team, the Captain uses the project plan directly
  as the plan — there's no PRD step.

Attaching a plan is always optional; leave it off and the Captain works from the
description alone.

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
