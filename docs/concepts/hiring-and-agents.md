---
title: Hiring & customizing agents
order: 9
section: Concepts
---

# Hiring & customizing agents

A team's roster isn't fixed. You can hire new agents, retire ones you don't need, and
tune how each agent behaves - both from the web app and by asking the CEO.

## Hiring a new agent

**Hire agent** on the Team page (or the **+** beside Team in the project menu) asks how you
want to go about it, and offers three ways:

- **Browse the marketplace** - take a proven role out of one of the ready-made teams. It
  arrives with a written system prompt, a budget and a face, and the CEO fits it to the team
  you already have. See [Team marketplace](/docs/concepts/marketplace).
- **Ask the CEO** - opens a chat thread for this project with the opening message written for
  you. Add what you need, send, and the CEO works out the role and drafts it. It checks the
  marketplace first and tells you which role it started from.
- **Write the role yourself** - the hire screen, where you fill in the role and its system
  prompt directly.

The three differ in where they end. A marketplace role is added by the CEO without a separate
approval, because you already chose it off the catalog. The other two come back to you as an
**approval**: the CEO writes or tidies the full role spec and files it, and you can **modify**
the role, system prompt, budget, heartbeat and code access before approving. Nothing is added
to the roster that way without your sign-off.

HQ is not staffed from here. It holds the CEO and Coach, who work across every project.

When you hire an agent you set:

- **Role** - its title and a short description of what it's responsible for.
- **Reports to** - the manager this agent answers to. This sets the reporting line in the
  org chart, which is what lets work be delegated to and from the agent, so it's worth
  getting right (it defaults to the Captain). You can change it later from the agent's
  settings, and the Captain/CEO can also adjust reporting lines during a coherence review.
- **System prompt** - the instructions that define how it works. Write the role itself:
  Hezo adds the agent's identity (its team, the team's description, its manager) above what
  you write, and its live context (skills, team preferences, project docs, today's date)
  below it, on every run. Nothing is required of your text, and the strip above the editor
  lists every block Hezo adds. If you want one of those values at a specific point in your
  own wording instead, type `{{` in the editor to insert it - Hezo then leaves its own copy
  of that value out.
- **Model** - which provider/model it runs on (defaults to the team's model; override
  per agent if you want).
- **Heartbeat** - how often it wakes to look for work. There is no default: the cadence
  drives both how fast the agent picks up work and how much it spends, so you pick it
  yourself and the hire form will not submit until you have. The shortest cadence the
  scheduler runs is 60 minutes. When the CEO or a Captain files the hire instead, it asks
  you for the cadence before filing rather than choosing one for you. The agent's page
  shows a live countdown to its next heartbeat (hidden while the agent is disabled or
  paused).
- **Budget** - optional spending limits (see
  [Budgets & cost control](/docs/concepts/budgets-and-costs)).
- **Code access** - whether the agent works in the project's code workspace.

Once approved, the agent is onboarded into the team and starts picking up work on its
heartbeat.

## New agents wait for the team setup review

Adding an agent - by hiring one, or by provisioning a whole roster when a project is
created - files a **team setup review** task automatically. That review is what fits the
new agent to the team: it reconciles reporting lines, rewrites the descriptive blobs
teammates read, and gives the agent the team context its every run is built on.

Until that review is done, any task assigned to the new agent is created **Blocked**, with
the setup review listed as its blocker on the task page. Nothing is lost and nobody has to
remember to sequence it: when the review is marked done, every task waiting on it moves
back to Backlog and its assignee is woken automatically. This applies however the task was
filed - by you in the web app, or by the CEO, a Captain or a teammate.

Agents already on the team are unaffected: they keep picking up work as normal while a new
teammate's setup review is open. If you deliberately want a new agent to start before its
review lands, remove the blocker from the task's page.

## Editing system prompts

Every agent's system prompt is editable from its settings at any time. Changes take
effect on the agent's next run, so you can correct course - tighten scope, add a
convention, change tone - without rebuilding anything. An edit can never cost the agent its
identity or live context: Hezo composes both around whatever you save. Switch to
**Preview** to read the whole prompt as the agent receives it, with every value filled in.

## Reviewing an agent's runs

Every agent has an **Executions** tab listing its runs - what triggered each one, how long
it took, what it cost, and the full log. The list opens on every run, newest first. The
filter above it narrows to a single outcome: **All**, **Succeeded** (runs that finished
cleanly) or **Errored** (runs that failed or timed out). A run that is still queued or
running, or one that was cancelled, belongs to neither narrow view and appears under All.
The choice is part of the page address, so a filtered view can be bookmarked or shared,
and opening a run and coming back returns you to the view you were in.

A run waiting its turn shows as queued, not as an error - it keeps its place and starts as
soon as whatever it is waiting for is free. A run waits for a container to free up when the
instance is already at its limit. If the wait outlasts its patience the run is recorded as
cancelled and the work goes back on the queue to be picked up again; that is not a failure,
and it is why cancelled runs are their own thing rather than errors. Hover the queued run's
info icon to see the reason. See
[how much can run at once](/docs/containers/overview#how-much-can-run-at-once).

The model provider can also turn a run away before the agent gets a turn - the model is at
capacity, the request was rate limited, or a subscription's usage allowance is spent. The
run consumed nothing, so Hezo treats it the same way: the run is recorded as cancelled and
the work goes back on the queue. It waits a few minutes before trying again, rather than
retrying straight into a provider that is still busy, and longer when the reason is a spent
allowance, which resets on a much slower clock. Nothing on your side clears this one - no
container frees it - so the wait is for the provider to recover. Press **Run now** on the
task to try again immediately. If the work is still being turned away after two hours, Hezo
stops retrying and raises an item in your Inbox, so a long outage does not sit unnoticed;
switching the agent or task to another model is usually the fastest way through. That
Inbox item is a notice rather than a decision: it opens the task, and **Dismiss** clears it.
You rarely need to: the agent's next successful run clears it for you, on whichever task or
project that run happens.

Cancelled covers one more case, and it is the only one that asks anything of you. If a run
is queued but never begins - Hezo lost track of it before the agent launched - the work is
put back on the queue and runs again on its own. Should that keep happening, Hezo stops
after three attempts, says so on the run, posts a note in the task, and raises an item in
your Inbox, with the same task link and **Dismiss** as the provider notice above, and cleared
the same way by the agent's next successful run. That run
carries a **Retry** button, which is the only cancelled run that does:
a run you stopped yourself, or one whose work is already back on the queue, has nothing
left to press. A run like that is not counted as an error, so it does not raise the task's
error marker; the note in the task and the Inbox item are how you find it.

## Per-agent model override

By default the agents on a team share the team's model. You can override the model for
any individual agent, so (for example) one agent runs on a frontier model for hard
reasoning while the rest run on something cheaper and faster. Mixing providers within a
single team is fully supported. See [AI model support](/docs/ai-models).

## Retiring & reinstating agents

When a team no longer needs a role, you can **retire** (disable) the agent - from its
settings in the web app, or just by asking the CEO. Retiring stops the agent from being
scheduled and unassigns it from any open tasks, but keeps all of its history, so it's
fully reversible: reinstate (enable) it at any time and it picks work back up on its
heartbeat. The CEO actions this directly once you confirm, which is handy after a
project's direction changes and several roles no longer fit. (A team's Captain can't be
retired by the CEO - only an admin can, from the web app. The global CEO and Coach run
coordination and review across every project, so they're essential and can't be retired
at all.)

## Other settings

You can also adjust an agent's heartbeat interval and budgets over time, and pause or
resume agents when you need to. Standing preferences you give the CEO in chat are
remembered and applied going forward.
