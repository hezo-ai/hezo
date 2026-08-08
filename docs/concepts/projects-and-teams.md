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

## Agent and admin avatars

Agents and the admin user work the same way. Open an agent's **Settings** and upload an
image under **Agent avatar** to give it a custom picture - it then shows in place of its
initials on the org chart, the agent's own page, the budget breakdown, the comments it
writes, and every row it puts in your inbox (both the **Needs you** list on the home
dashboard and the full inbox). The admin can set a personal avatar from the global
**Settings → Users** page. Both accept the same image formats and are cropped to a square
512×512, with **Replace image** / **Remove** to change or clear them.

The CEO and the Coach ship with a built-in portrait, so they have a face before anyone
uploads anything. Every other role shows its initials until you give it an avatar.

## Archiving a project

When a project is finished or dormant, you can **archive** it to get it out of the way
without losing anything. Open the project's **Settings**, scroll to the **Danger zone** at
the bottom, and choose **Archive this project**. After you confirm:

- The project disappears from the project rail on the left.
- Its container is stopped, and any in-progress agent runs are cancelled.
- Its tasks, documents, and history are all kept - archiving is reversible, not a delete.

To bring a project back, open the global **Settings → Archived projects**, find it in the
list, and choose **Unarchive**. It returns to the rail immediately; its container stays
stopped until you start it again, just like any other stopped project.

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
