---
title: Projects & teams
order: 7
section: Concepts
---

# Projects & teams

## One project, one team

A **project** is the primary unit of work in Hezo, and every project owns exactly one
**team** — its roster of agents. The relationship is one-to-one: a team backs a single
project. You don't manage teams separately; you reach a team through its project.

This keeps things clean: a project's agents, tasks, budget, container, and connections
all belong to that project and nothing leaks between them.

## Project icon

By default a project shows its initials in the project rail. To give it a distinct look,
open the project's **Settings** and upload an image under **Project icon** — it then
appears as the project's thumbnail in the rail. Pick any common image (PNG, JPEG, WebP,
GIF, or SVG); Hezo crops it to a square and resizes it to 512×512. Use **Replace image**
to swap it or **Remove** to go back to the initials.

## Agent and admin avatars

Agents and the admin user work the same way. Open an agent's **Settings** and upload an
image under **Agent avatar** to give it a custom picture — it then shows on the team
roster, the org chart, and the agent's own page in place of its initials. The admin can set
a personal avatar from the global **Settings → Users** page. Both accept the same image
formats and are cropped to a square 512×512, with **Replace image** / **Remove** to change
or clear them.

## Archiving a project

When a project is finished or dormant, you can **archive** it to get it out of the way
without losing anything. Open the project's **Settings**, scroll to the **Danger zone** at
the bottom, and choose **Archive this project**. After you confirm:

- The project disappears from the project rail on the left.
- Its container is stopped, and any in-progress agent runs are cancelled.
- Its tasks, documents, and history are all kept — archiving is reversible, not a delete.

To bring a project back, open the global **Settings → Archived projects**, find it in the
list, and choose **Unarchive**. It returns to the rail immediately; its container stays
stopped until you start it again, just like any other stopped project.

Archiving and unarchiving are admin (superuser) actions.

## Team templates

When you create a project you choose a **template**, which decides the starting roster.
Every template gives the team a **Captain** to lead it. The global CEO and Coach
are never part of a template — they live in HQ (below). A template is only the starting
point — you change the team's structure freely from there; see
[Team structure](/docs/concepts/team-structure) for the bigger picture.

Hezo ships with the minimal **Blank** template plus a set of ready-made teams in the
[team marketplace](/docs/concepts/marketplace) — an **App Team** that builds software, an
**Influencer Marketing** team that grows a creator's reach, and an **Investment** team that
researches and tracks stocks. Each agent's behaviour comes from a **system
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

### App Team

Named **App Team** in the marketplace, this is a **Captain** plus a full
software-development roster — the team that builds your app. Its Captain asks you a few
scoping questions first (what to build, where it deploys, constraints) rather than
assuming, and can suggest project goals for you to approve.

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/software-development/captain.md) —
  leads the team, breaks the goal into tasks, and coordinates delivery.
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

### Influencer Marketing team

A content team that grows a creator's social reach. Its Captain onboards you first —
asking which accounts to work on (connect them on the project's Connections page), your
persona and brand, and your goals for the next 3, 6, and 12 months — and suggests goals for
you to approve. **By default no content is published until you approve it** (you can turn
that off in the team's preferences).

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/captain.md) —
  runs onboarding, sets the content strategy, and owns the content-approval policy.
- [Brand Strategist](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/brand-strategist.md) —
  learns your brand and voice, owns the content pillars and the content calendar.
- [Trend Researcher](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/trend-researcher.md) —
  tracks trends and competing creators and feeds ideas to the strategy.
- [Content Writer](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/content-writer.md) —
  drafts posts, scripts, threads, and captions in your voice.
- [Media Producer](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/media-producer.md) —
  generates images, video, and audio via connected media providers.
- [Content Editor](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/content-editor.md) —
  the verification gate: proofreads, fact-checks, and reviews voice and brand safety.
- [Distribution Manager](https://github.com/hezo-ai/hezo/blob/main/agents/influencer/distribution-manager.md) —
  publishes approved content, cross-posts, and runs the engagement/analytics loop.

### Investment team

A research team that tracks stocks and produces research-grade analysis (**not financial
advice**). Its Captain onboards you first — which stocks and categories to watch, your
objective and risk appetite, and your time horizon — and suggests goals for you to approve.
It maintains a living document per stock (with full revision history) and monitors filings
and news day to day.

- [Captain](https://github.com/hezo-ai/hezo/blob/main/agents/investment/captain.md) —
  runs onboarding, sets the research agenda and watchlist, and tracks goals.
- [Market Researcher](https://github.com/hezo-ai/hezo/blob/main/agents/investment/market-researcher.md) —
  screens the market and sources candidate stocks and sectors to watch.
- [Equity Analyst](https://github.com/hezo-ai/hezo/blob/main/agents/investment/equity-analyst.md) —
  runs fundamental deep-dives and maintains the per-stock analysis document.
- [Catalyst Monitor](https://github.com/hezo-ai/hezo/blob/main/agents/investment/catalyst-monitor.md) —
  sweeps SEC/EDGAR filings, news, and industry trends daily and notifies you of anything material.
- [Risk Verifier](https://github.com/hezo-ai/hezo/blob/main/agents/investment/risk-verifier.md) —
  the verification gate: challenges every thesis and verifies claims and citations.
- [Report Writer](https://github.com/hezo-ai/hezo/blob/main/agents/investment/report-writer.md) —
  produces the periodic portfolio and watchlist reviews.

## The project plan document

When you create a project you can optionally attach a **project plan document** — a
fuller brief than the description field, describing what the project is for: goals,
scope, context, and constraints. It's saved into the project's docs as `project-plan.md`
and the Captain is told to use it as the starting point for planning.

How it's used depends on the team:

- On a **software development** team, the project plan is the input the Product Lead turns
  into the formal PRD. On UI-bearing work the UI is designed and approved first, and the
  technical spec and implementation are then planned against that approved design.
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

**HQ** is the one special, global team. It's the permanent home of the two roles
that work across every project — the **CEO** and the **Coach** — and it's where
meta-level work happens: tasks that don't fit into any particular project run in HQ,
and the CEO keeps non-project documents and assets there. (Global settings — model
providers, shared connections, and the like — are not part of HQ; they apply to your
whole Hezo install and are managed from the global Settings pages.) HQ is
also where you [chat with the CEO](/docs/concepts/roles-and-coordination#chatting-with-the-ceo):
when you talk to it to create a new project or check in on any team, you're talking to the
CEO in HQ. See [Roles & the CEO](/docs/concepts/roles-and-coordination).
