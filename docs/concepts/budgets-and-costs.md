---
title: Budgets & cost control
order: 15
section: Concepts
---

# Budgets & cost control

Autonomous agents can run up a model bill quickly. Hezo tracks every run's cost and
lets you cap spend at both the agent and the project level.

The money tabs live on a project's **Team & Budget** page, beside the **Team** tab that
holds the roster. There are two of them, because there are two different bills:

- **Budget** - what the agents cost in model tokens.
- **Hours** - what the containers cost in uptime.

## Cost tracking

Each agent run records what it cost, based on the tokens it used and the pricing for
the model it ran on. Costs roll up two ways (**per agent** and **per project**), so
you can see exactly where spend is going from the budget view.

**Chat turns are counted too.** A reply in the assistant chat bills its tokens the
same way a run does, under the replying agent and its project, and an agent or
project at its budget limit pauses in chat as well: the thread shows a notice, and
the conversation carries on with your next message once the window rolls over or
you raise the limit.

Model pricing ships built in and refreshes daily from
[pricepertoken.com](https://pricepertoken.com), so rates stay current without any
setup. The catalog carries no cache rates, so Hezo derives them from each model's
input rate: Anthropic bills cache reads at a tenth of the input rate and cache
writes at a small premium, OpenAI bills cache reads at a tenth with no write
premium, and agent runs are cache-heavy, so this is most of what a run costs.

For a provider whose cache rates are not yet known, cache traffic still bills at
the full input rate, which makes those particular figures a **conservative
upper-bound estimate** - your real bill is lower than the figure shown, never
higher. For exact billing on a model (or to correct a rate), add a manual pricing
override in Settings - overrides win and can include cache rates.

## Subscription runs are costed but not billed

A provider you signed into with a subscription does not charge per token, so there
is no bill for Hezo to track. It still records what each run would have cost at the
provider's published API rates, and shows that figure marked as not billed.

This exists because the alternative is worse: with nothing recorded, a team running
entirely on subscriptions saw an empty spend page while getting through billions of
tokens a week, and the first sign of trouble was the provider cutting them off.

The figure is there to show you what the fleet is doing, not to budget against:

- It **never** counts towards a daily, weekly or monthly limit.
- It **never** pauses an agent.
- It is kept separate from real spend everywhere both are shown, so "what did this
  cost me" stays answerable.

If you want a hard stop on subscription usage, the controls that apply are the
per-agent run time limit and the per-run tool-call ceiling, not a budget.

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
- **Chat is counted too.** Chat replies run in the same containers as task runs -
  each reply borrows one for its duration - so their uptime is part of the same
  figure. A container a chat recently used stays warm for 15 minutes after the
  last message, then stops on its own.
- **It is not the same as agent run time.** Run time is per agent and ignores the
  build, the warm-idle tail, and the fact that concurrent runs share one container.
  Each agent's run time for the month is shown on the **Budget** tab, beside its spend.

On a local Docker daemon an hour of uptime costs nothing, so the Hours tab is there to
show you what the fleet is doing rather than to budget against.

### The monthly allowance

Where container hours do cost money, you can set a **monthly allowance** from HQ's
Hours tab (under **Team & Budget**). Once it is spent:

- No new container starts - chat replies included, so an exhausted allowance
  pauses chat too until the month turns or the allowance is raised.
- Runs that land on a container **already up** carry on - they spend no new hours, and
  stopping them would idle a container you are paying for anyway.
- Runs that need a new container queue, and say so.

The allowance returns when the calendar month turns. It is unset by default, which
means no limit.
