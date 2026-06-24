---
title: Hiring & customizing agents
order: 11
section: Concepts
---

# Hiring & customizing agents

A team's roster isn't fixed. You can hire new agents, retire ones you don't need, and
tune how each agent behaves — both from the web app and by asking the CEO.

## Hiring a new agent

There are two ways a hire gets started: you fill in the hire screen directly, or you
tell the CEO you need a new role and let the team draft it for you. In the second case
the CEO directs the team's Captain to write the full role spec and file it as a hire
proposal — so the agents do the drafting work, and the proposal lands in your inbox
ready to review. Either way you stay in control: a hire always surfaces as an
**approval**, and you can **modify** the proposed role, system prompt, budget, heartbeat,
and code access before approving it. Nothing is added to the roster without your sign-off.

When you hire an agent you set:

- **Role** — its title and a short description of what it's responsible for.
- **System prompt** — the instructions that define how it works. Helpers let you
  reference team and project context so the prompt stays in sync as things change.
- **Model** — which provider/model it runs on (defaults to the team's model; override
  per agent if you want).
- **Heartbeat** — how often it wakes to look for work. The agent's page shows a live
  countdown to its next heartbeat (hidden while the agent is disabled or paused).
- **Budget** — optional spending limits (see
  [Budgets & cost control](/docs/concepts/budgets-and-costs)).
- **Code access** — whether the agent works in the project's code workspace.

Once approved, the agent is onboarded into the team and starts picking up work on its
heartbeat.

## Editing system prompts

Every agent's system prompt is editable from its settings at any time. Changes take
effect on the agent's next run, so you can correct course — tighten scope, add a
convention, change tone — without rebuilding anything.

## Per-agent model override

By default the agents on a team share the team's model. You can override the model for
any individual agent, so (for example) one agent runs on a frontier model for hard
reasoning while the rest run on something cheaper and faster. Mixing providers within a
single team is fully supported. See [AI model support](/docs/ai-models).

## Retiring & reinstating agents

When a team no longer needs a role, you can **retire** (disable) the agent — from its
settings in the web app, or just by asking the CEO. Retiring stops the agent from being
scheduled and unassigns it from any open tasks, but keeps all of its history, so it's
fully reversible: reinstate (enable) it at any time and it picks work back up on its
heartbeat. The CEO actions this directly once you confirm, which is handy after a
project's direction changes and several roles no longer fit. (A team's Captain and the
instance-wide CEO and Coach can't be retired this way.)

## Other settings

You can also adjust an agent's heartbeat interval and budgets over time, and pause or
resume agents when you need to. Standing preferences you give the CEO in chat are
remembered and applied going forward.
