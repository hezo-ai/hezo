---
title: Team marketplace
order: 7.6
section: Concepts
---

# Team marketplace

The **team marketplace** is a catalog of ready-made teams. Instead of building a roster from
scratch, you can pick a proven team - like a full software-development team with a Captain,
Architect, Engineer, QA, and more - and either launch a brand-new project with it or add it to
a project you already have.

Open it from the **Marketplace** button in the top navigation (just left of Settings).

## Browsing teams

The marketplace lists every available team with its name, a short description, how many roles it
includes, and its version. Click a team to see its full details:

- the **roster** - every teammate by name and face, their role, who they report to, and what
  they're responsible for. A team ships a fixed name per role, so you meet the same people here
  that you'll work with once the project exists. The Captain is listed by role alone;
- the **version** and **changelog** - what changed in each release of the team;
- two actions: **Launch new project** and **Add to a project**.

## Launching a new project

**Launch new project** creates a fresh project together with its own team, staffed with the
whole roster. Give the project a name and description and Hezo provisions the team, opens the
Captain's planning task, and starts the initial CEO team-setup pass - exactly like creating a
project from a team type, but with the marketplace team's roles and prompts.

You can also reach these teams from the other direction: every marketplace team appears in
the New project dialog's team catalog, where opening one shows the same roster without
leaving the flow.

## Adding a team to an existing project

**Add to a project** brings a marketplace team's roles into a project you already have. Rather
than adding them silently, Hezo opens a task for the **CEO**, which:

1. hires the team's roles onto the project's team (no separate approval - you already chose to
   add them), and
2. reconciles the combined roster - adjusting reporting lines, summaries, and prompts so the new
   and existing roles work together.

If the project was originally created from that same team, the CEO recognizes this as a **version
update** rather than a duplicate add: it refreshes the existing roles to the newer prompts,
preserving any customizations you've made, instead of creating parallel copies.

## Adding only some of a team's roles

You don't have to take the whole roster. The same **Add to a project** dialog asks what you want to
add: **the whole team**, or **just the roles you choose** from a checklist. So you can bring only
the Security Engineer, or the Content Editor and the Trend Researcher, into a project that already
has its own team. The Captain isn't on the list - every project already has one.

Picking a subset changes what the CEO does. Those roles are being lifted out of a roster they were
written for, and the rest of that team isn't coming with them, so their prompts assume teammates
your project may not have. The CEO:

1. reads each chosen role and compares it against the team it is joining;
2. **asks you first** when a role doesn't clearly belong - when an existing agent already covers
   that responsibility, when the role's way of working depends on teammates your project doesn't
   have, or when there is no sensible manager for it. It posts the question on the task and waits.
   If some of your picks are clear and others aren't, it adds the clear ones and asks about the rest;
3. hires them, leaving the rest of the project's roster untouched;
4. rewrites each one's prompt around the teammates it actually has, gives it a manager, and updates
   the agents whose work now flows through it.

So what you get is fitted to your project, not a copy of what's in the catalog. A role your project
already has is skipped rather than duplicated.

The CEO also draws on the marketplace when you talk to it about hiring: asked to staff a team, it
checks the catalog for a proven role that matches before writing a new one from scratch, and tells
you which one it started from.

## Versions and updates

Each team carries a whole-number **version** and a changelog. Because your instance always reads
the live marketplace, improvements to the default teams become available automatically - you
don't need to upgrade Hezo to get them. New projects launched from a team always use its latest
version, and you can bring an existing team up to date by adding it to the project again.

## Exporting your team

Once you've shaped a team - refined its roster, adjusted reporting lines, tuned each role's
prompt and settings - you can package that whole state as a **team bundle** and share it. On the
Team page, the **Export team** button (next to **Hire agent**) opens a short dialog that explains
what's about to happen, then downloads a single JSON file describing your team.

The bundle captures the team name, description, and summary; every role, from the Captain to each
teammate, with its reporting line; and each role's system prompt, effort, budgets, and settings.
It's the same self-contained format the marketplace ships. It does **not** include skills,
connections, secrets, or project data - those are configured per project, not carried by a team.

To have your team added to the marketplace, send the downloaded file to the Hezo authors on
GitHub. They review it, generate a changelog, and publish it so anyone can launch a project from
your team.

## Where teams come from

The marketplace teams are maintained in the Hezo repository and served from there. A running
instance fetches the catalog live; a development server serves it from your local copy. If your
instance can't reach the network, it falls back to the set of teams bundled with your build, so a
default team is always available.
