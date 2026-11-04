---
title: Budgets & cost control
order: 15
section: Concepts
---

# Budgets & cost control

Autonomous agents can use up a provider allowance or a model bill quickly. Hezo counts
every token each run and chat turn uses, lets you cap that per agent and per project,
lets you cap each project's container hours, and stops the loops a budget alone would
not catch.

These tabs live on a project's **Team & Budget** page, beside the **Team** tab that holds
the roster. There are two of them, because agents use two different things:

- **Tokens** - the model tokens the agents use, and the token budget.
- **Hours** - how long the containers are up, and the project's hours budget.

## Token usage

Each agent run records the tokens it used: input, cached input included, plus output.
That total is what budgets count, for every run, whatever pays for it: an API key, a
subscription, or a model on your own hardware. Hezo keeps no price list, so a figure
never depends on a price it has to guess. Usage rolls up two ways (**per agent** and
**per project**), so the budget view shows where the tokens went.

**Antigravity runs count low.** Once per run, Antigravity sends the whole prompt to a
small Gemini model to give the conversation a title. It does not report that call's
tokens, and nothing turns the call off, so Hezo cannot count them. Google counts more
tokens for an Antigravity run than Hezo shows.

**Chat turns are counted too.** A reply in the assistant chat counts its tokens the same
way a run does, under the replying agent and its project, and an agent or project at
its budget limit pauses in chat as well: the thread shows a notice, and the conversation
carries on with your next message once the window rolls over or you raise the limit.

## Budget windows

You set token limits over three rolling windows, in UTC:

- **Daily** - from the start of the day.
- **Weekly** - from the start of the week (Monday).
- **Monthly** - from the start of the month.

The budget editors take millions of tokens, so `20` means 20,000,000. Limits apply to
both **agents** and **projects**, independently. A limit of zero means **unlimited** for
that window.

**Every agent starts with no limit**, the built-in roles included. Set one where you want
a ceiling. The per-run and per-task limits below still apply to every agent.

## Enforcement

When an agent (or the project it belongs to) reaches a budget limit in any window, its
runs are paused, and a notice in your inbox names the budget, the window and what was
used. The notice is on the task the agent was working, or on the project's planning task
when the run had no task of its own, and you get one per agent, budget and window. The agent resumes
on its own when that window rolls over (the next day, week, or month), or as soon as you
raise the limit.

You can also pause and resume agents yourself at any time, independently of budgets.

## Limits that apply without a budget

Some work goes wrong in ways no daily limit catches in time. These apply to every
agent, whether or not it has a budget:

- **A single run stops at 30 million tokens.** A run that long spends most of its tokens
  re-reading its own context. This applies to every runtime. For Codex, Grok and Kimi Code,
  Hezo reads the usage once a minute, so a run can go a little past the limit before it
  stops. A run that has already finished its work is never stopped. When a run is stopped
  this way, or at the tool-call ceiling below, its task waits for your reply before any agent
  runs on it again, since the next run would start the same oversized work. You get a notice
  in your inbox; scope the task down or split it, then reply. A **Retry** or **Run now** you
  start also lets agents back on the task. If that run is stopped for its size too, the task
  waits for you again.
- **A task stops at 100 million tokens** used since you last replied on it. Hezo
  puts a notice in your inbox, and no agent runs on the task until you reply. Your reply
  wakes the task's assignee and allows another 100 million, and **Run now** starts one
  agent yourself. A teammate who is not an admin cannot release it either way.
- **A subscription's allowance is spread across its window.** Hezo reads how much of the
  week a Codex or Claude Code subscription has used and holds agent work that gets ahead of
  an even pace. The Tokens tab shows where each subscription's week stands, under
  **Subscription usage**. See [How Hezo paces a subscription](/docs/ai-models#how-hezo-paces-a-subscription).
- **Agents cannot pass a task back and forth forever.** After 8 rounds in a row without
  a reply from you, the task waits for you. See
  [Comments and mentions](/docs/concepts/tasks#comments-and-mentions).
- **Each run has a time limit and a tool-call ceiling.** The time limit is a per-agent
  setting (see [Hiring and agents](/docs/concepts/hiring-and-agents#other-settings)); the
  tool-call ceiling is global (see
  [Configuration](/docs/deployment/configuration)).

## Upgrading from dollar budgets

Budgets counted dollars before this release, and skipped runs on a subscription. When an
instance upgrades, every non-zero dollar budget becomes a token budget at that
instance's own rate: the list price of its runs over the previous 30 days. An instance
with no priced runs in that window converts at one million tokens per dollar. A limit of
zero stays unlimited. Where more than one window is set, a longer one is raised if it
would fall below what the shorter ones allow.

Budgets count usage from the upgrade on. Earlier usage stays in the charts but counts
against no budget, because many of those runs were never counted before. A pending hire
proposal whose budget was not a dollar amount becomes unlimited.

A notice on an HQ task in your inbox lists each converted budget, old and new, and any
proposal budget that became unlimited, so you can adjust them. A request that still
sends a dollar budget field, such as `monthly_budget_cents`, is refused with an error
naming the field that replaced it.

## Container hours

Agents run inside containers, and a container costs money for as long as it is up -
not only while an agent is mid-run. The **Hours** tab measures that directly, from a
ledger of when each container was running.

A project's Hours tab shows that project's hours only, and says so at the top. HQ's
Hours tab shows every project's hours, split by project, and that total is what the
hours allowance counts. Admins get a link from each project's tab to HQ's, and on an
instance whose limits a deployment sets, an **Hours by project** entry in the Settings
menu beside the plan.

Hours count for as long as the backend bills the container. Counting starts when Hezo
asks the backend to create or start it, before the container is ready, because a managed
backend bills the time it spends creating and starting. Counting ends when the backend
has finished stopping or removing the container, which can be a minute or more after Hezo
asked. A container that stops and resumes three times therefore reads as four separate
stretches, with the gaps between them costing nothing but reserved disk.

Three things affect how that figure reads:

- **Concurrent containers add up.** Two containers up for one hour is two container
  hours, which is what a provider charges for.
- **Chat is counted too.** Chat replies run in the same containers as task runs -
  each reply borrows one for its duration - so their uptime is part of the same
  figure. The container a chat used last stays warm for two minutes after the
  reply, then stops on its own.
- **It is not the same as agent run time.** Run time is per agent and ignores the
  build, the warm-idle tail, and the fact that concurrent runs share one container.
  Each agent's run time for the month is shown on the **Tokens** tab, beside its tokens.
  That one really is a calendar month, and is a different figure from the hours below.

On a local Docker daemon an hour of uptime costs nothing, so there the Hours tab is a
record of what the fleet is doing rather than something to budget against.

### The hours allowance

Where container hours do cost money, you can set an **hours allowance** from HQ's
Hours tab (under **Team & Budget**). Once it is spent:

- No new container starts, until more hours are added or the period turns - chat
  replies included, so an exhausted allowance pauses chat too.
- Runs that land on a container **already up** carry on - they spend no new hours, and
  stopping them would idle a container you are paying for anyway.
- Runs that need a new container queue, and say so.

It is unset by default, which means no limit.

**The period is usually the calendar month, but not always.** A deployment that
bills you on the day you subscribed anchors the allowance to that day instead, so
the hours you are capped against cover the period you are charged for. The Hours
tab names the period it is measuring and the date the allowance comes back, so
you never have to work out which one you are on.

Where part of a fixed allowance was bought on top of the plan, the Hours tab shows
the two apart. The plan's hours come back each period, and bought hours carry over
until they are used.

Where the allowance is fixed by whoever runs your instance, HQ's Hours tab says
so and links to where it can be changed. The same link, **Buy more hours**, sits
beside the date the allowance resets. Once the allowance is spent, the instance's
admin also finds it in three more places: the notice after pressing **Run now** or
**Retry**, the tip on a **Run now** button the spent hours have disabled, and the
chat's warning above the composer.

### A project's hours budget

Each project can also have an **hours budget**: limits on how many container hours its
containers may be up in a day, a week and a period. Use it to decide where an
instance's hours go, so that one busy project cannot use the whole allowance.

- **Only an instance owner can set it.** The hours are one pool that every project draws
  on, so a project's admins can see its limits but cannot change them. An owner sets
  them on the project's **Hours** tab, with **Edit limits**.
- **The windows follow the allowance.** The daily limit counts the UTC day, and the
  weekly limit counts from Monday, as token budgets do. The monthly limit counts over
  the allowance's own period, so where your hours renew on a billing date, the
  project's limit renews on the same date.
- **Longer limits cover shorter ones**, as for token budgets. A weekly limit is at least
  seven times the daily limit. A monthly limit is at least the daily limit times 365/12
  (about 30.4), and at least the weekly limit times 52/12. The editor raises a longer
  limit for you as you type.
- **At a limit, the project's new work waits.** Agents with work in the project are
  paused, a chat reply in the project is refused with a notice, and you get one inbox
  notice per window. Runs already going finish, so a project can go a little past its
  limit. Work starts again on its own when the window turns, or as soon as an owner
  raises the limit.
- **A limit sets no hours aside.** The allowance still applies to every project, and it
  can run out before a project reaches its own limit. HQ's Hours tab shows how the
  projects' monthly limits add up against the allowance.
- **HQ has no hours budget.** The CEO's and the Coach's work draws on the allowance
  directly.

On a local Docker daemon an hour costs nothing, so the Hours tab offers no hours budget
there unless one is already set.

Through the API, a project's hours budget is read with
`GET /api/projects/:projectId/container-hours` and set with
`PATCH /api/projects/:projectId/container-hours`, in seconds:
`daily_budget_container_seconds`, `weekly_budget_container_seconds` and
`monthly_budget_container_seconds`, with 0 for no limit.
