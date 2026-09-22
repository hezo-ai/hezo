---
title: Team structure
order: 7.5
section: Concepts
---

# Team structure

A team's **structure** is how its work is organised: which roles exist, how they report to
each other, what each one is good at, and the tools, knowledge, and judgement they share.
That arrangement is the part of an AI system that is hard to copy, and in Hezo it is
something you compose, change, and reuse rather than something fixed at setup.

A team's structure is the same idea as a *dynamic agent workflow*: instead of one fixed
pipeline of model calls, the arrangement of the agents is chosen to fit the work in front
of it, and changes as the work does. In Hezo that arrangement is an org chart of agents
that you can pick a starting point for, evolve while a project runs, and carry forward to
the next project.

## What makes up a team's structure

A team's structure is more than a list of agents. It's:

- **The roster** - which roles exist on the team (a Captain plus whatever specialists the
  work needs). See [Roles & the CEO](/docs/concepts/roles-and-coordination).
- **The reporting lines** - who reports to whom. Work is delegated up and down these lines,
  so the org chart decides how the team operates rather than only describing it.
- **What each role is** - every agent's [system prompt](/docs/concepts/hiring-and-agents#editing-system-prompts),
  which defines its responsibilities, conventions, and how it works, plus the model it
  runs on.
- **What the team shares** - its [skills](/docs/concepts/skills),
  [project documents and memory](/docs/concepts/documents-and-memory),
  connected [external services](/docs/mcp/connecting-mcp-servers), budgets, and the project
  workspace their containers work in.

Change any of these and you've changed the team's structure.

## Choosing a starting structure

Every project starts from a **team** - the minimal **Blank** team (just a Captain) or one
of the ready-made teams in the [marketplace](/docs/concepts/marketplace): a full
software-development **App Team**, a **Social Media Marketing** team, or an **Investment
Portfolio** team. You can also save and add your own. For the built-in rosters and a link to every
role's prompt, see [Team templates](/docs/concepts/projects-and-teams#team-templates).

None of them is a commitment. The Blank team is designed to be grown into whatever the work
needs; the App Team is a fully-staffed structure for building software, and the Social Media
Marketing and Investment Portfolio teams are staffed for content and stock research
respectively. Pick whichever is closest and adjust from there. When none of them is obviously
right for the work, start from Blank: an ill-fitting roster costs more to unpick than an empty
one does to fill.

## Changing a team's structure while it runs

A team's structure is meant to change as a project does. Nothing about it is locked in
once the project is created:

- **Hire** new roles when the work calls for a specialist the team doesn't have, and
  **retire** roles it has outgrown - both are reversible, and a retired agent keeps its
  history. See [Hiring & customizing agents](/docs/concepts/hiring-and-agents).
- **Rewire reporting lines** to change how work flows through the team.
- **Edit any agent's system prompt** to refine what a role does, or
  [give a single agent its own model](/docs/concepts/hiring-and-agents#per-agent-model-override).

You drive this in plain language through the
[CEO chat](/docs/concepts/roles-and-coordination#chatting-with-the-ceo) - "this project
needs a data analyst", "have QA report to the Architect" - and the CEO proposes the
change and asks you to approve anything consequential. When a team's roster changes, the
team's own Captain runs a **coherence review** to re-align the reporting lines and role
descriptions so the new structure hangs together (the CEO runs this pass only for a
brand-new team's initial setup, or for a team without a Captain). Part of that review is checking that every role's
work is still **verified** - reviewed by someone other than the agent who produced it,
whether by a manager, a dedicated reviewing role, or review steps written into the
agents' prompts - and closing the gap when it isn't.

## Reusing a structure

A structure you've tuned - its roles, prompts, reporting lines, skills, and connections -
is worth keeping. Rather than rebuild it for the next project, you can:

- **Save a team as a template** so its structure becomes a reusable option in the template
  picker, or
- **Start a new project directly from an existing team**, which snapshots that team's
  structure as the new project's starting point.

Either way the new project gets its own independent team - the two never affect each
other. See
[Reusing a team setup](/docs/concepts/projects-and-teams#reusing-a-team-setup).

## Improving the team within its structure

A team also gets better without any change to its structure. The
[Coach](/docs/concepts/coach-and-self-improving-teams) makes the team's *existing* agents
work better, leaving the roster and the reporting lines as they are. Every
time a task is completed (other than a team coherence review), the Coach reviews how it
went and writes durable **learned rules** back onto the agents that need them, and sometimes updates a project document or
skill - so the same mistake doesn't happen twice and the existing agents coordinate more
smoothly over time.

Restructuring a team and coaching it are separate things: one changes *who's on the team
and how they report*, the other *how the existing agents work*. Because the coaching
improvements live in the agents' own prompts, a structure you save and reuse carries them
forward too.

> [!TIP]
> A roster, its reporting lines and its prompts travel with a team you save and start the
> next project from, so the tuning you do on one project does not have to be done again on
> the next. Skills do not: they are configured per project, not carried by a team.
