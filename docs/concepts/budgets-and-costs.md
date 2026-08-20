---
title: Budgets & cost control
order: 15
section: Concepts
---

# Budgets & cost control

Autonomous agents can run up a model bill quickly. Hezo tracks every run's cost and
lets you cap spend at both the agent and the project level.

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

## Enforcement

When an agent (or the project it belongs to) reaches a budget limit in **any** window,
its runs are **paused**. The agent automatically resumes when that window rolls over
(the next day, week, or month). This gives you a hard ceiling on spend without having
to babysit it: set a daily cap and a runaway agent simply stops until tomorrow.

You can also pause and resume agents yourself at any time, independently of budgets.
