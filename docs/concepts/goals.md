---
title: Goals
order: 10.5
section: Concepts
---

# Goals

**Goals are optional - and recommended.** Every project already has a
[**Progress** page](/docs/concepts/progress) the Captain keeps current whether or not you set any.
Goals add a layer on top of it: the high-level **outcomes** the project is working toward, tracked
over time with a percentage, a health, and a chart.

Where tasks are the individual pieces of work on the board, goals are the outcomes those tasks add
up to - and they give you, the admin, a way to see how far along a project is and where things
stand **without micromanaging the board.** Adding one or two is the single best way to make a
project's progress legible; not adding any costs you nothing else.

A goal is an **outcome or milestone you want the project to achieve** - a state of the world
you care about: a level to reach ("reach 100 active customers"), or a level to reach and hold
("keep the error rate under 1%"). Its **measurement** judges results, never activity -
"monitor the watchlist daily" or "deliver a weekly report" is not a goal but recurring
operational work, which the team runs as a task that stays open (see the callout below). A
one-off deliverable with a fixed done state - a document to produce, a feature to ship, a
one-time analysis - belongs on the board as a **task** too (the Captain can link it to a
goal). Goals are re-checked on their cadence until you archive them, so a reached milestone
stays tracked (and held) rather than quietly slipping.

You set the goals; the **Captain** keeps them up to date. You don't have to remember to
update a status or move a slider - the Captain re-checks each goal on its schedule and writes
a fresh estimate.

The Captain (or the CEO) can also **suggest goals** - but goals start with you. During a
project's initial onboarding the Captain asks what you want the project to achieve and
formulates suggestions from your answers; it shouldn't invent goals you didn't ask for. A
suggestion isn't a goal yet: it appears as an **Approve / Deny** card on the task thread and
on the **Goals** page, and only becomes a real goal once you approve it. Deny it and it's
dismissed. You stay in control of which goals the team actually tracks.

> **There is no cron in Hezo - and goals aren't one either.** Hezo has no cron or
> timed-trigger system to configure; repeating work runs on the **heartbeat**: agents wake on
> their own cadence and revisit the open tasks assigned to them. Recurring operational work -
> a daily monitoring sweep, a weekly report - is a **standing task**: an ordinary task that
> stays open and is never marked done, with each round filed as a sub-task under it (see
> [Recurring work and standing tasks](/docs/concepts/tasks#recurring-work-and-standing-tasks)).
> Goals are different: they track the **outcomes you want** - on each due check the Captain
> assesses progress and turns the assessment into steering (a comment on an in-flight task) or
> new tasks. A goal's check frequency schedules the Captain's re-assessment, not the work itself.

## The Goals page

Goals live under **Progress** in the project menu, at **Progress > Goals**. The page shows each
goal as a panel with its progress, health, and latest status; click a panel to open the goal's own
page, where its full progress chart and history live. An **Active** / **Archived** filter switches
between live goals and retired ones.

Back on the [**Progress** page](/docs/concepts/progress), your goals are summarised by the **goal
indicator** in the header: one bar per goal, filled to its own progress and coloured by its health,
with the overall percentage beside it. Click it to come here.

## Setting a goal

From the **Goals** page choose **Create Goal** (or the **+** button in the Goals header). A
goal has:

- **Goal name** - the objective in a line (e.g. "Reach 100 active customers").
- **Measurement** - the precise definition of *how you'll know the goal is achieved* (e.g.
  "100 active paid subscriptions in Stripe"). This is the bar the Captain measures against, so
  the more concrete it is, the more honest its progress estimates.
- **Suggested actions** *(optional)* - guidance on what the Captain should do or check when
  it assesses the goal (e.g. "read the signup-funnel numbers, not just the task board").
  Leave it blank to let the Captain decide.
- **Deadline** *(optional)* - when the goal should be met. The Captain weighs progress against
  this date when it sets the goal's health, and once the deadline has passed an unmet goal is
  checked on every heartbeat, regardless of its check frequency, until it reaches 100% or is
  archived. At 100% the goal drops back to its normal check frequency (and the every-heartbeat
  urgency returns if its progress later slips below 100 again).
- **Check frequency** - how often the Captain re-assesses the goal: **daily** (the default),
  **weekly**, or **monthly**. This schedules the Captain's assessment, not the team's work -
  pick it by how often the measurement meaningfully changes: daily for fast-moving
  measurements, monthly for slow-moving outcomes.

The create and edit forms keep the **SMART** framework (Specific, Measurable, Achievable,
Relevant, Time-bound) in front of you as a reminder. A project can have any number of goals;
until you've set one, a gentle dot pulses next to **Progress** in the menu as a nudge to create
your first. Editing a goal (from the goal's own page or the panel's edit control) reopens the
same form.

## How the Captain tracks goals

Goal assessment rides along with the [**progress update**](/docs/concepts/progress#progress-update-runs) -
the standalone Captain run that rebuilds the Progress page. That run happens whether or not the
project has goals; when it does, the same run also picks up whichever goals are **due** and assesses
them all at once.

A goal is due when its **check frequency** has come round (last checked longer ago than its cadence,
or never checked) **or** once its **deadline** has passed - a goal past its deadline is always
checked and never skipped while it stays active. Goals that aren't due on either count are skipped;
the progress update still runs, it simply has no goal work to do. A due goal also makes a progress
update due, so setting goals means the Progress page refreshes at least as often as your shortest
check frequency.

For each due goal the Captain assesses real progress toward the outcome - reading the relevant
tasks, comments, and project state rather than just counting finished tasks - and records three
things:

- a **progress percentage** (0-100) - its honest estimate of how far along the goal is,
- a **health** - a coloured pill that reads at a glance: **on track** (green), **at risk**
  (amber), or **off track** (red); a brand-new goal shows **not assessed** (grey) until its
  first check,
- a **status blurb** - a short paragraph on where the goal stands and what's needed next. Any
  tasks or pull requests it references become links you can click straight through to.

Because each check is recorded, every goal shows a **progress chart** of how its percentage
has moved over time, so you can see momentum (or a stall) at a glance.

These progress updates are **not** done inside a task - they're standalone Captain runs. The recent
progress update runs for the whole project appear at the bottom of the
[**Progress** page](/docs/concepts/progress#progress-update-runs), along with the **Run now** button
that triggers one on demand. Each goal's own page also has a **Progress update runs** section showing
just the runs that did something for *that* goal - the progress it set and any tasks it created or
commented on toward the goal show inline, and each run expands to reveal the status summary it
recorded.

During the same run the Captain also rewrites the project progress summary and the recent-activity
columns, so the whole Progress page stays in step with the goal estimates.

## Goals aren't finished at 100%

Reaching **100% doesn't end tracking**. A goal that hits 100% stays in rotation and keeps being
re-assessed on its check frequency, because progress can move back **below** 100: a goal like
"reach 100 active customers" is met one week and slips to 95 the next when customers churn. When
that happens the Captain lowers the percentage (explaining why in the blurb) and the progress
chart shows the dip.

That also means goals can be deliberately **never-ending** - a standing objective like "keep the
error rate under 1%" or "respond to every support ticket within a day" is measured continuously,
forever, and simply hovers around 100% while it's being met. The only way to stop the Captain
checking a goal is to **archive** it (below) - do that when a goal has served its purpose and
is no longer worth tracking.

## Archiving

The Goals page defaults to an **Active** view and has an **Archived** filter to see the rest.
Archiving a goal (from the archive button on its card, or the same button on the goal's own page)
sets it aside without deleting it: an archived goal is **no longer checked** - the Captain skips it
entirely and never updates its status or files work for it.

Because that quietly retires something the team is working toward, archiving **asks you to confirm
first**, naming the goal in the prompt so you can tell it apart from the card next to it. Nothing
is sent until you confirm. Unarchiving needs no confirmation - it is the undo of that action - and
brings the goal straight back into rotation.

## Goals and the board

When the Captain decides a goal needs a push, it either **comments on an existing in-flight
task** to steer or unblock it, or **files new tasks** through the normal delegation flow and
links them to the goal. But it doesn't create work for its own sake: if tasks already in the
backlog or in flight will advance the goal, the Captain leaves the board alone. The point of a
progress update is to judge whether the project is on course - not to manufacture busywork every
time a goal comes due. The Captain never re-opens a closed task; if something needs redoing it files
a fresh task that points back at the original.

The estimate is exactly that - an estimate, made by the Captain. Treat the **blurb** as the
primary signal and the **percentage** as a quick gauge of direction. Together they let you
glance at a project and know where it's headed without reading every task.

> Goals are a per-project concept. The global **HQ** project does not have goals.
