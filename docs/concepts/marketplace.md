---
title: Team marketplace
order: 7.6
section: Concepts
---

# Team marketplace

The **team marketplace** is a catalog of ready-made teams. Instead of building a roster from
scratch, you can pick a proven team — like a full software-development team with a Captain,
Architect, Engineer, QA, and more — and either launch a brand-new project with it or add it to
a project you already have.

Open it from the **Marketplace** button in the top navigation (just left of Settings).

## Browsing teams

The marketplace lists every available team with its name, a short description, how many roles it
includes, and its version. Click a team to see its full details:

- the **roster** — every role, who it reports to, and what it's responsible for;
- the **version** and **changelog** — what changed in each release of the team;
- two actions: **Launch new project** and **Add to a project**.

## Launching a new project

**Launch new project** creates a fresh project together with its own team, staffed with the
whole roster. Give the project a name and description and Hezo provisions the team, opens the
Captain's planning task, and starts the initial CEO team-setup pass — exactly like creating a
project from a team type, but with the marketplace team's roles and prompts.

## Adding a team to an existing project

**Add to a project** brings a marketplace team's roles into a project you already have. Rather
than adding them silently, Hezo opens a task for the **CEO**, which:

1. hires the team's roles onto the project's team (no separate approval — you already chose to
   add them), and
2. reconciles the combined roster — adjusting reporting lines, summaries, and prompts so the new
   and existing roles work together.

If the project was originally created from that same team, the CEO recognizes this as a **version
update** rather than a duplicate add: it refreshes the existing roles to the newer prompts,
preserving any customizations you've made, instead of creating parallel copies.

## Versions and updates

Each team carries a whole-number **version** and a changelog. Because your instance always reads
the live marketplace, improvements to the default teams become available automatically — you
don't need to upgrade Hezo to get them. New projects launched from a team always use its latest
version, and you can bring an existing team up to date by adding it to the project again.

## Where teams come from

The marketplace teams are maintained in the Hezo repository and served from there. A running
instance fetches the catalog live; a development server serves it from your local copy. If your
instance can't reach the network, it falls back to the set of teams bundled with your build, so a
default team is always available.
