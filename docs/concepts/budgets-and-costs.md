---
title: Budgets & cost control
order: 15
section: Concepts
---

# Budgets & cost control

Autonomous agents can run up a model bill quickly. Hezo tracks every run's cost and
lets you cap spend at both the agent and the project level.

A project's **Budget** page has two tabs, because there are two different bills:

- **Spend** - what the agents cost in model tokens.
- **Hours** - what the containers cost in uptime.

## Cost tracking

Each agent run records what it cost, based on the tokens it used and the pricing for
the model it ran on. Costs roll up two ways (**per agent** and **per project**), so
you can see exactly where spend is going from the budget view.

Model pricing ships built in and refreshes daily from
[pricepertoken.com](https://pricepertoken.com), so rates stay current without any
setup. The catalog carries no cache rates, so Hezo derives them from each model's
input rate: Anthropic bills cache reads at a tenth of the input rate and cache
writes at a small premium, and agent runs are cache-heavy, so this is most of what
a run costs.

For a provider whose cache rates are not yet known, cache traffic still bills at
the full input rate, which makes those figures a **conservative upper-bound
estimate** - your real bill is lower than the figure shown, never higher. For exact
billing on a model (or to correct a rate), add a manual pricing override in
Settings - overrides win and can include cache rates.

## Budget windows

You set limits over three rolling windows, in UTC:

- **Daily** - from the start of the day.
- **Weekly** - from the start of the week (Monday).
- **Monthly** - from the start of the month.

Limits apply to both **agents** and **projects**, independently. A limit of zero means
**unlimited** for that window.

**New agents ship with no cap.** Set one where you want a ceiling; until you do, an
agent's spend is bounded only by its project's caps and by `run_timeout_min`. Agents
hired before this release keep whatever cap they were given.

## Enforcement

When an agent (or the project it belongs to) reaches a budget limit in **any** window,
its runs are **paused**. The agent automatically resumes when that window rolls over
(the next day, week, or month). This gives you a hard ceiling on spend without having
to babysit it: set a daily cap and a runaway agent simply stops until tomorrow.

You can also pause and resume agents yourself at any time, independently of budgets.

## Container hours

Agents run inside containers, and a container costs money for as long as it is up -
not only while an agent is mid-run. The **Hours** tab measures that directly, from a
ledger of when each container was running.

An hour is counted from the moment a container starts being **built**, not from when
it is ready: on a managed backend the build (image resolve, clone, package install)
is the longest part of a cold start, and it is billed like any other minute. Counting
stops when the container stops. A container that stops and resumes three times
therefore reads as four separate stretches, with the gaps between them costing
nothing but reserved disk.

Three things are worth knowing about the figure:

- **Concurrent containers add up.** Two containers up for one hour is two container
  hours, which is what a provider charges for.
- **The assistant chat is counted too**, and reported separately so you can see its
  share. Its container stops on its own 15 minutes after the last message.
- **It is not the same as agent run time.** Run time is per agent and ignores the
  build, the warm-idle tail, and the fact that concurrent runs share one container.
  Each agent's run time for the month is shown on the **Spend** tab, beside its spend.

On a local Docker daemon an hour of uptime costs nothing, so the Hours tab is there to
show you what the fleet is doing rather than to budget against.

### The monthly allowance

Where container hours do cost money, you can set a **monthly allowance** from HQ's
Budget page. Once it is spent:

- No new container starts.
- Runs that land on a container **already up** carry on - they spend no new hours, and
  stopping them would idle a container you are paying for anyway.
- Runs that need a new container queue, and say so.

The allowance returns when the calendar month turns. It is unset by default, which
means no limit.
