---
title: Team shapes
order: 7.5
section: Concepts
---

# Team shapes

As models converge and features get copied, the part of an AI system that's hard to
reproduce isn't the code — it's how the work is organised: which roles exist, how they
report to each other, what each one is good at, and the tools, knowledge, and judgement
they share. That arrangement is a team's **shape**, and in Hezo it's a first-class thing
you compose, reshape, and reuse — not a fixed structure you're stuck with.

A team's shape is the same idea as a *dynamic agent workflow*: instead of one fixed
pipeline of model calls, the structure of the agents is chosen to fit the work in front
of it, and changes as the work does. In Hezo that structure is an org chart of agents
that you can pick a starting point for, evolve while a project runs, and carry forward to
the next project.

## What makes up a shape

A team's shape is more than a list of agents. It's:

- **The roster** — which roles exist on the team (a Captain plus whatever specialists the
  work needs). See [Roles & the CEO](/docs/concepts/roles-and-coordination).
- **The reporting lines** — who reports to whom. This org chart is what lets work be
  delegated up and down the team, so it shapes how the team actually operates, not just
  how it looks.
- **What each role is** — every agent's [system prompt](/docs/concepts/hiring-and-agents#editing-system-prompts),
  which defines its responsibilities, conventions, and how it works, plus the model it
  runs on.
- **What the team shares** — its [skills](/docs/concepts/skills),
  [project documents and memory](/docs/concepts/documents-and-memory),
  connected [MCP tools](/docs/mcp/connecting-mcp-servers), budgets, and the project
  container they all work in.

Change any of these and you've reshaped the team.

## Choosing a starting shape

Every project starts from a **template**, which decides the team's initial shape. Hezo
ships with a minimal **Blank** team (just a Captain) and a full software-development
**Startup** team, and you can add your own. For the built-in rosters and a link to every
role's prompt, see
[Team templates](/docs/concepts/projects-and-teams#team-templates).

A template is just a convenient starting point — it's not a cage. The Blank team is
designed to be grown into whatever the work needs; the Startup team is a fully-staffed
shape for building software. Pick whichever is closest and adjust from there.

## Reshaping a team while it runs

A team's shape is meant to change as a project does. Nothing about it is locked in once
the project is created:

- **Hire** new roles when the work calls for a specialist the team doesn't have, and
  **retire** roles it has outgrown — both are reversible, and a retired agent keeps its
  history. See [Hiring & customizing agents](/docs/concepts/hiring-and-agents).
- **Rewire reporting lines** to change how work flows through the team.
- **Edit any agent's system prompt** to refine what a role does, or
  [give a single agent its own model](/docs/concepts/hiring-and-agents#per-agent-model-override).

You drive this in plain language through the
[CEO chat](/docs/concepts/roles-and-coordination#chatting-with-the-ceo) — "this project
needs a data analyst", "have QA report to the Architect" — and the CEO proposes the
change and asks you to approve anything consequential. When a team's roster changes, the
Captain runs a **coherence review** to re-align the reporting lines and role descriptions
so the new shape hangs together.

## Reusing a shape

A shape you've tuned — its roles, prompts, reporting lines, skills, and connections — is
worth keeping. Rather than rebuild it for the next project, you can:

- **Save a team as a template** so its shape becomes a reusable option in the template
  picker, or
- **Start a new project directly from an existing team**, which snapshots that team's
  shape as the new project's starting point.

Either way the new project gets its own independent team — the two never affect each
other. See
[Reusing a team setup](/docs/concepts/projects-and-teams#reusing-a-team-setup).

## Shapes that improve themselves

Team shapes don't just change on demand — they get better as the team ships. Every time a
task is completed, the [Coach](/docs/concepts/coach-and-self-improving-teams) reviews how
it went and writes durable **learned rules** back onto the agents that need them, and
sometimes updates a project document or skill. Over many projects, the lessons baked into
a shape compound: a team you reuse carries forward not just its roster but everything it
has learned.

> [!TIP]
> The durable thing in Hezo isn't any single task or even any single project — it's the
> shape you build: a roster, reporting structure, prompts, skills, and learned rules that
> you tune once and carry forward. That accumulated structure is what makes the next
> project faster than the last.
