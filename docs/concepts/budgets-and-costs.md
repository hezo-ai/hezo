---
title: Budgets & cost control
order: 15
section: Concepts
---

# Budgets & cost control

Autonomous agents can use up a provider allowance or a model bill quickly. Hezo counts
every token each run and chat turn uses, lets you cap that per agent and per project,
and stops the loops a budget alone would not catch.

These tabs live on a project's **Team & Budget** page, beside the **Team** tab that holds
the roster. There are two of them, because agents use two different things:

- **Budget** - the model tokens the agents use.
- **Hours** - how long the containers are up.

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

You set limits in tokens over three rolling windows, in UTC:

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
  stops. A run that has already finished its work is never stopped.
- **A task stops at 100 million tokens** used since you last replied on it. Hezo
  puts a notice in your inbox, and no agent runs on the task until you reply. Your reply
  wakes the task's assignee and allows another 100 million, and **Run now** starts one
  agent yourself. A teammate who is not an admin cannot release it either way.
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

An hour is counted from the moment a container starts being **built**, not from when
it is ready: on a managed backend the build (image resolve, clone, package install)
is the longest part of a cold start, and it is billed like any other minute. Counting
stops when the container stops. A container that stops and resumes three times
therefore reads as four separate stretches, with the gaps between them costing
nothing but reserved disk.

Three things affect how that figure reads:

- **Concurrent containers add up.** Two containers up for one hour is two container
  hours, which is what a provider charges for.
- **Chat is counted too.** Chat replies run in the same containers as task runs -
  each reply borrows one for its duration - so their uptime is part of the same
  figure. A container a chat recently used stays warm for 15 minutes after the
  last message, then stops on its own.
- **It is not the same as agent run time.** Run time is per agent and ignores the
  build, the warm-idle tail, and the fact that concurrent runs share one container.
  Each agent's run time for the month is shown on the **Budget** tab, beside its tokens.
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

Where the allowance is fixed by whoever runs your instance, the Budget page says
so and links to where it can be changed.
