---
title: Projects & teams
order: 7
section: Concepts
---

# Projects & teams

## One project, one team

A **project** is the primary unit of work in Hezo, and every project owns exactly one
**team** - its roster of agents. The relationship is one-to-one: a team backs a single
project. You don't manage teams separately; you reach a team through its project.

This keeps things clean: a project's agents, tasks, budget, containers, and connections
all belong to that project and nothing leaks between them.

A project's containers run only while there is work: one starts automatically when an
agent run or the assistant needs it - each run going at once gets a container of its own
- and it stops again after sitting idle, so projects you aren't actively using cost
nothing.

## Project dashboard

Opening a project - from the rail or its URL - lands on the **Dashboard**. It is the
at-a-glance home for that project, listed first in the project sidebar (above **Inbox**).

A normal project dashboard shows, top to bottom:

- **Status** - the Captain's latest project summary (see
  [Goals & progress](/docs/concepts/goals)).
- **Action items** - what the project's **Inbox** holds unread: pending approvals, @admin
  mentions and credential requests. **Open inbox** always lands on the rows listed here,
  and reading one there clears it from the dashboard while the Inbox keeps it under
  **Read**.
- **In progress** - tasks currently in progress or review.
- **Team snapshot** - open-task count, last activity, and any agents currently running.
- **Goals** - the top goals by health.
- **Spend** - Today / This week / This month / All time, with the same calendar budget
  windows and caps as the [budget page](/docs/concepts/budgets-and-costs).

Status and action items stay at the top. The four below them are yours to arrange: drag a
widget by the handle that appears at its top-left on hover, and the new order is saved for
that project.

**HQ** gets a minimal dashboard: action items, in-progress work, and the team snapshot -
no spend, progress summary, or goals (those belong to ordinary projects).

## Project icon

By default a project shows its initials wherever it is listed. To give it a distinct look,
open the project's **Settings** and upload an image under **Project icon** - it then
appears as the project's thumbnail everywhere the project is shown with an avatar: the
project rail and the home dashboard's project cards and rows. Pick any common image (PNG,
JPEG, WebP, GIF, or SVG); Hezo crops it to a square and resizes it to 512×512. Use
**Replace image** to swap it or **Remove** to go back to the initials.

HQ works the same way. Give it an icon and the pinned HQ entry at the bottom of the rail
shows it in place of the default building symbol.

## Reordering the project rail

The rail lists your projects newest first. Once you have more than a few, the one you
work in every day drifts down the list - so you can drag the avatars into whatever order
you like:

- **On a computer**, press an avatar and drag it up or down the rail.
- **On a phone or tablet**, press and hold an avatar for a moment until it lifts, then
  drag. A quick swipe still scrolls the rail as usual.
- **From the keyboard**, focus an avatar and press **Alt+Up** or **Alt+Down** to move it
  one place at a time.

The order is saved as soon as you drop, and it applies everywhere projects are listed -
the rail, the home dashboard, and the project pickers. New projects still arrive at the
top. HQ stays pinned at the bottom of the rail and is not part of the ordering.

Reordering is an admin (superuser) action, because the order is shared across everyone
using this Hezo install.

## Agent names

Every agent has a **role** - what it does, like "Engineer" or "Content Writer" - and that
role is what you see by default: the roster, the org chart, the sidebar, the comments an
agent writes, and the assignee on a task all show it. A team you start from the
marketplace arrives addressed entirely by role.

An agent can also have a **name**, like Max or Priya. Giving it one is your call, not
something the team decides for you: open the agent's **Settings** and set it. From then on
the name is what shows everywhere, with the role alongside it - on the team page the role
sits beneath the name, and hovering a name anywhere shows both plus what the role does.
Clear the name to go back to the role.

A name belongs to that project's copy of the agent, and it sticks: updating the team later
never renames a teammate you have been working with. Pulling a single role out of a team
into another project starts it unnamed there.

The Captain, the CEO and the Coach are always shown by their role rather than a name -
there is one of each, and their role is who they are.

### Mentioning an agent

An agent always answers to its role (`@engineer`). Once you name it, it answers to the
name as well (`@max`), and both wake it. Type `@` in a comment and the picker searches
names and roles together. Whichever handle you type, the posted comment shows the agent's
display name - so `@max` and `@engineer` read the same in the thread. Renaming an agent
moves its name handle; the role handle never changes, so older comments keep working.

Names are unique within a team, and a name can never collide with a role handle already in
use.

## Agent and admin avatars

Every agent has a generated pixel-art avatar, shown in place of its initials on the org
chart, the agent's own page, the budget breakdown, the comments it writes, and every row it
puts in your inbox. The picture reflects the role - the Captain's cap, a headset for
support - and follows the agent's name.

Avatars are generated by Hezo rather than uploaded. To change one, open the agent's
**Settings** and choose **Generate new avatar**: you are shown three options, and the one
you pick becomes the agent's avatar. Generate again for three more. Like a name, a
generated avatar belongs to that project and travels with the team if you export it.

The CEO and the Coach ship with a built-in portrait of their own.

The admin user is different: you upload a personal picture from the global
**Settings → Users** page. It accepts common image formats and is cropped to a square
512×512, with **Replace image** / **Remove** to change or clear it.

## Archiving a project

When a project is finished or dormant, you can **archive** it to get it out of the way
without losing anything. Open the project's **Settings**, scroll to the **Danger zone** at
the bottom, and choose **Archive this project**. After you confirm:

- The project disappears from the project rail on the left.
- Any in-progress agent runs are cancelled, and its containers are removed.
- Its agents stop being scheduled. An archived project's tasks are not picked up by a
  heartbeat, and no new container is started for it.
- Its tasks, documents, and history are all kept - archiving is reversible, not a delete.
  Anything a repository clone holds, including commits an agent has not pushed yet, stays
  on disk.

To bring a project back, open the global **Settings → Archived projects**, find it in the
list, and choose **Unarchive**. It returns to the rail immediately and its agents are
scheduled again; the next run starts a fresh container, the same way it does for any
project that does not have one.

Archiving and unarchiving are admin (superuser) actions.

## Team templates

When you create a project you choose a **template**, which decides the starting roster.
Every template gives the team a **Captain** to lead it. The global CEO and Coach
are never part of a template - they live in HQ (below). A template is only the starting
point - you change the team's structure freely from there; see
[Team structure](/docs/concepts/team-structure) for the bigger picture.

Hezo ships with the minimal **Blank** template plus a set of ready-made teams in the
[team marketplace](/docs/concepts/marketplace) - an **App Team** that builds software, a
**Social Media Marketing** team that grows a creator's reach, and an **Investment
Portfolio** team that researches and tracks stocks.

You don't have to know which one you want up front. As you describe the project in the
**New project** dialog, Hezo suggests the teams that best fit what you wrote - describe a
todo list app and you'll be offered the App Team. **View all teams** always shows the full
catalog if you'd rather choose yourself, and opening any team there shows its **roster** -
every role, who it reports to, and what it's responsible for - before you commit;
**Select team** confirms your choice and takes you back to the project details.

Each agent's behaviour comes from a **system prompt** that you can read (and, once hired,
customise - see [Hiring & customizing agents](/docs/concepts/hiring-and-agents)). The links
below point at the source prompt for each role.

### Blank team

Just a **Captain** - the minimal baseline. Hire roles as you need them.

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/blank/captain.md) - leads
  the team, turns the brief (and any attached [project plan](#the-project-plan-document))
  into an execution plan, and escalates to the CEO. Because the team starts with only the
  Captain, this Captain produces a plain **project plan** rather than a formal product
  requirements document (PRD).

### App Team

Named **App Team** in the marketplace, this is a **Captain** plus a full
software-development roster - the team that builds your app. Its Captain asks you a few
scoping questions first (what to build, where it deploys, constraints) rather than
assuming, and can suggest project goals for you to approve.

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/captain.md) -
  leads the team, breaks the goal into tasks, and coordinates delivery.
- [Architect](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/architect.md) -
  technical vision, specs, and architecture decisions; gates and schedules the deploy.
- [Product Lead](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/product-lead.md) -
  owns scope and requirements; turns the brief (and any attached project plan) into the
  formal **PRD**.
- [Engineer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/engineer.md) -
  implementation, tests, and code.
- [QA Engineer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/qa-engineer.md) -
  testing, code quality, and the final approval gate.
- [Security Engineer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/security-engineer.md) -
  security review, threat modelling, and vulnerability analysis.
- [UI Designer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/ui-designer.md) -
  visual and interaction design, component architecture, and HTML mockups.
- [DevOps Engineer](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/devops-engineer.md) -
  infrastructure, CI/CD, and staging/production deployment.
- [Marketing Lead](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/marketing-lead.md) -
  marketing strategy, content, public documentation, and launch.
- [Researcher](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/researcher.md) -
  competitive analysis, technical research, and feasibility studies.

### Social Media Marketing team

A content team that grows a creator's social reach. Its Captain onboards you first -
asking which accounts to work on (connect them on the project's Connections page), your
persona and brand, and your goals for the next 3, 6, and 12 months - and suggests goals for
you to approve. **By default no content is published until you approve it** (you can turn
that off in the team's preferences).

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/captain.md) -
  runs onboarding, sets the content strategy, and owns the content-approval policy.
- [Brand Strategist](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/brand-strategist.md) -
  learns your brand and voice, owns the content pillars and the content calendar.
- [Trend Researcher](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/trend-researcher.md) -
  tracks trends and competing creators and feeds ideas to the strategy.
- [Content Writer](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/content-writer.md) -
  drafts posts, scripts, threads, and captions in your voice.
- [Media Producer](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/media-producer.md) -
  generates images, video, and audio via connected media providers.
- [Content Editor](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/content-editor.md) -
  the verification gate: proofreads, fact-checks, and reviews voice and brand safety.
- [Distribution Manager](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/distribution-manager.md) -
  publishes approved content, cross-posts, and runs the engagement/analytics loop.

### Investment Portfolio team

A research team that tracks stocks and produces research-grade analysis (**not financial
advice**). Its Captain onboards you first - which stocks and categories to watch, your
objective and risk appetite, and your time horizon - and suggests goals for you to approve.
It maintains a living document per stock (with full revision history) and monitors filings
and news day to day.

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/investment/captain.md) -
  runs onboarding, sets the research agenda and watchlist, and tracks goals.
- [Market Researcher](https://github.com/hezo-ai/hezo/blob/main/agents/investment/market-researcher.md) -
  screens the market and sources candidate stocks and sectors to watch.
- [Equity Analyst](https://github.com/hezo-ai/hezo/blob/main/agents/investment/equity-analyst.md) -
  runs fundamental deep-dives and maintains the per-stock analysis document.
- [Catalyst Monitor](https://github.com/hezo-ai/hezo/blob/main/agents/investment/catalyst-monitor.md) -
  sweeps SEC/EDGAR filings, news, and industry trends daily and notifies you of anything material.
- [Risk Verifier](https://github.com/hezo-ai/hezo/blob/main/agents/investment/risk-verifier.md) -
  the verification gate: challenges every thesis and verifies claims and citations.
- [Report Writer](https://github.com/hezo-ai/hezo/blob/main/agents/investment/report-writer.md) -
  produces the periodic portfolio and watchlist reviews.

## The project plan document

When you create a project you can optionally attach a **project plan document** - a
fuller brief than the description field, describing what the project is for: goals,
scope, context, and constraints. It's saved into the project's docs as `project-plan.md`
and the Captain is told to use it as the starting point for planning.

How it's used depends on the team:

- On a **software development** team, the project plan is the input the Product Lead turns
  into the formal PRD. On UI-bearing work the UI is designed and approved first, and the
  technical spec and implementation are then planned against that approved design.
- On a **blank** (or other non-software) team, the Captain uses the project plan directly
  as the plan - there's no PRD step.

Attaching a plan is always optional; leave it off and the Captain works from the
description alone.

## Reusing a team setup

Spent time tuning a team (its roles, prompts, and connections) and want the same
starting point again? You don't have to rebuild it:

- **Save a team as a template** so it shows up as a reusable option for future
  projects, or
- **Start a new project directly from an existing team**, which snapshots that team's
  roster as the new project's starting point. Existing teams appear on the "Copy
  existing team" tab of the team catalog, and opening one shows the roles it has
  actually hired so far - so you can check what you're copying before you do.

Either way the new project gets its own independent team - changes to one never affect
the other.

## HQ - the home team

**HQ** is the one special, global team. It's the permanent home of the two roles
that work across every project (the **CEO** and the **Coach**), and it's where
meta-level work happens: tasks that don't fit into any particular project run in HQ,
and the CEO keeps non-project documents and assets there. (Global settings - model
providers, shared connections, and the like - are not part of HQ; they apply to your
whole Hezo install and are managed from the global Settings pages.) HQ is
also where you [chat with the CEO](/docs/concepts/roles-and-coordination#chatting-with-the-ceo):
when you talk to it to create a new project or check in on any team, you're talking to the
CEO in HQ. See [Roles & the CEO](/docs/concepts/roles-and-coordination).
