# Squad (squad.so) — competitive analysis

**Point-in-time note, 2026-09-13.** Not a rule. Sources are Squad's public marketing
site and its published product manual; nothing here comes from a paid account, so
claims are what Squad says it does, not what was verified running. Every claim links
to the page that carries it. Hezo claims are cited to a file and line in this repo at
`a5db517`.

## What Squad is

"AI teammates to do your work." A hosted, single-owner workspace where named agents
run business operations on a schedule: chasing invoices, triaging an inbox, writing a
Monday report. $99/month for the platform; you bring your own model subscription, so
Squad takes no per-token cut. Optional add-ons are research credits ($5 per 5,000 past
a free 1,000/month) and extra agent email inboxes ($10/month each).
[Pricing](https://squad.so/pricing), [Costs, caps and what uses
credits](https://squad.so/resources/docs/costs-credits).

Its five nouns are Squad, Mission, Ticket, Run, Doc. The loop it sells: delegate →
agents work → a ticket when it needs you → you decide in seconds → work ships → the
squad remembers it. [What Squad
is](https://squad.so/resources/docs/what-is-mchq).

Hezo and Squad overlap on the core idea — a roster of named agents, a board, a
human-approval gate, bring-your-own-model, shared memory, skills, MCP connectors,
Telegram/Discord access. They differ on deployment (self-hosted vs hosted), on who the
buyer is (project teams shipping work vs back-office ops), and on where each has spent
its engineering.

## Scorecard

| Capability | Squad | Hezo |
|---|---|---|
| Named agent roster, a lead, a board | yes | yes, plus org chart and reporting lines |
| Bring your own model subscription | yes | yes |
| Per-agent model | yes | yes |
| Ordered model / account fallback chain | yes | no |
| Time-anchored schedules (cron, calendar) | yes | no, heartbeat only |
| Agent-authored blocking escalation, typed | yes | partly, `@admin` only |
| Cross-project run log with cost and failures | yes | no, per-agent per-project only |
| Outbound notification (email, push, proactive DM) | yes | no |
| Agent email inboxes with draft-for-review | yes | no |
| Persistent per-agent browser profile | yes | no |
| Teach-by-demonstration skill capture | yes | no |
| Per-agent connector access | yes | no, project or global |
| Read-only public share link | yes | no |
| Native mobile app | yes (iOS) | no, installable PWA |
| Self-hosted, own keys, no platform fee | no | yes |
| Secrets never enter the agent's environment | no | yes |
| Per-project container isolation | no (one computer per squad) | yes |
| Verified git commits, signing key outside the sandbox | no | yes |
| Budget caps that pause and auto-resume | no (caps only on credits and email) | yes |
| Multiple human accounts on one instance | no | no |

## The gaps, ranked

### 1. Nothing tells you an approval is waiting

**Squad.** Settings → Notifications lists every event with separate in-app and email
switches. Defaults follow one rule: you hear about things only you can unblock
(escalations, blocked missions, billing), and the routine hum stays visible but silent.
A Monday weekly digest goes to email. There is an iOS app positioned as "the decision
device". [Notifications](https://squad.so/resources/docs/notifications),
[FAQ](https://squad.so/resources/docs/faq).

**Hezo.** Approvals, credential requests and `@admin` questions land in the Inbox
(`docs/getting-started/first-project.md:61`) and on the project Dashboard's action
items. Nothing leaves the browser. There is no notification setting anywhere in the app
(no route under `packages/web/src/routes/settings/`). The service worker exists only to
satisfy PWA installability and does no caching and no push
(`packages/web/src/lib/register-sw.ts:1-9`). The chat channels cannot fill the gap
either: the CEO is mention-driven and "never posts unprompted"
(`docs/chat/slack.md:82`, `docs/chat/discord.md:48`).

**Why this is the worst of them.** Hezo's pitch is that agents work while you do not
watch, and its safety model is that consequential steps stop and wait for you. Those two
things only compose if the waiting reaches you. Today an `@admin` question holds a task
open indefinitely (`docs/concepts/tasks.md:50-54`) with no signal outside the tab. A
heartbeat is at minimum 60 minutes (`docs/reference/mcp-api.md:665`), so an unnoticed
block can burn a day.

**Cheapest useful version.** Web push through the service worker that is already
registered, plus a proactive DM on an already-connected chat channel for Inbox items.
Both reuse infrastructure that exists. A per-event on/off matrix can come later; the
default set is small — approval pending, `@admin` question, run failed, budget paused,
provider credential expired.

### 2. Agents cannot raise an arbitrary decision

**Squad.** A ticket is an agent saying "I could guess here, but I shouldn't." It carries
typed sub-asks — a decision to make, an approval to give, a fact to fill in, access to
grant, or an action only you can take — plus context, options and a recommendation.
Resolve every sub-ask and the mission unblocks itself; the agent resumes where it
stopped. There is an Undo, a "Discuss with [agent]" path, and an Archive-all for the
queue. Squad even states a health bar: 1 to 5 tickets a day, each decidable in under a
minute. [Tickets](https://squad.so/resources/docs/tickets).

**Hezo.** `ApprovalType` is a closed set of nine platform-defined types — hire,
project creation, strategy, plan review, deploy production, designated repo request,
skill proposal, goal suggestion, role update
(`packages/shared/src/types/common.ts:793-809`). There is no generic tool for an agent
to open one: the MCP surface has `list_approvals` and `resolve_approval` but no
`create_approval` or `ask_admin` (`docs/reference/mcp-api.md`). An agent facing a
judgment call outside those nine — spend this, send this to a customer, pick direction A
or B — has only an `@admin` mention in a comment. That does block completion, which is
right, but it is unstructured: no options, no recommendation, no typed resolution, and
the human answers in prose that the agent must re-read and interpret.

**Worth doing.** A generic agent-raised approval with a question, an option set, an
optional recommended option and a free-text fallback. It fits the existing approval
machinery (`packages/server/src/services/approval-handlers/`), the existing Inbox, and
the existing "hold the task open" semantics. It is the single highest-leverage addition
after notifications, and the two compound: a structured question is worth pushing.

### 3. There is no clock

**Squad.** A scheduled task is instructions plus a cadence (daily 7 AM, every Friday,
cron), with a model override, a timeout, and whether to announce completion. A Calendar
screen shows what the workspace actually has scheduled, a Scheduled screen lists every
schedule across every agent with run-now, pause, edit, duplicate and reassign, and a
schedule written so it could never fire gets a NEVER RUNS flag with a one-click Fix all.
Heartbeats exist too, as the lighter cousin, and the config warns when a heartbeat and a
schedule overlap. [Schedules &
heartbeats](https://squad.so/resources/docs/schedules-heartbeats).

**Hezo.** "There is no cron in Hezo" is an explicit design stance
(`docs/concepts/goals.md:41`). Recurring work is a standing task that is never marked
done, revisited on the agent's heartbeat; a goal's check frequency schedules the
Captain's re-assessment, not the work.

**The honest read.** The stance is defensible and mostly right: for work whose timing
does not matter, a heartbeat is simpler than a schedule and cannot drift into a
never-fires state. But it is the wrong instrument for work that is genuinely
clock-bound. "Post the Monday report at 07:00" and "run the month-end close on the last
business day" are not interval work, and a 60-minute-minimum heartbeat cannot express
either. Squad's whole demo set is clock-bound: weekdays 9 AM, weekdays 7 AM, Mondays
7 AM ([homepage](https://squad.so/)).

**Recommendation, narrow.** Keep the heartbeat as the default and the only way most
recurring work happens. Add a time-anchored wake on a task: "wake the assignee at this
local time on these days". No new agent-level schedule object, no calendar screen, no
second scheduler — the existing wake-up path with a time trigger instead of an interval.
That covers the clock-bound cases without reopening the design. **This one needs your
call before anyone builds it**, because it softens a stated stance.

### 4. No one place answers "what did my agents do today"

**Squad.** Runs is the flight recorder: every execution as a row with when, which agent,
what triggered it, duration, model, and success. The detail panel shows the skills
loaded, token usage split input/output/cache, tool request and response payloads, and a
jump to the mission. It navigates like a calendar (day/week/month, arrow keys, `t` for
today) and shows UPCOMING with countdowns. A separate Health screen carries today's
failures and interruptions. [Runs](https://squad.so/resources/docs/runs-guide), [When an
agent gets stuck](https://squad.so/resources/docs/agent-stuck).

**Hezo.** Executions are per agent per project
(`packages/web/src/routes/projects/$projectId/agents/$agentId/executions/`). The
Activity log is instance-wide but records project *changes* — task created, status
edited — not runs with model, duration, tokens and cost
(`docs/security/activity-log.md:17-20`). Budget pages are project-scoped
(`packages/web/src/routes/projects/$projectId/budget/`). So the questions "what failed
today, anywhere" and "where did this week's spend go" have no single answer.

**Worth doing, and cheap.** Hezo already records everything this needs — runs, costs,
models, failures. This is a view over existing data, not a new mechanism. A global Runs
page plus a failures-today filter would be the highest value-per-line item on this list.

### 5. Connectors cannot be scoped to an agent

**Squad.** Each integration connection supports scope presets (connect read-only where
read-only is enough), and per-agent access one click deeper: pin an agent to a narrower
level or block it from the app entirely, enforced on every call with no restart. Every
account row shows health, and "last used" jumps to that integration's runs. [Integrations
& secrets](https://squad.so/resources/docs/integrations-secrets).

**Hezo.** Connectors are scoped per project or to All projects
(`docs/mcp/connecting-mcp-servers.md:214-231`), with a per-connector method allowlist
(`docs/mcp/connecting-mcp-servers.md:255`). Every agent in a project sees the same set.

**Worth doing.** The org metaphor already implies it — a designer has no business
holding the payments API. Hezo has both axes it needs (a scope, and a method allowlist);
this adds an agent dimension to the scope. It also strengthens the security story that
is Hezo's main differentiator, so it earns its keep twice.

### 6. A stalled provider stops the agent

**Squad.** Multiple accounts per provider are first-class and the numbered priority order
*is* the fallback chain; if account one hits a limit the runtime tries the next. Agent
configuration also takes an ordered list of fallback *models* for when the primary is
unavailable — expired connection, rate limit, outage — and the list never offers the
primary as its own fallback. [AI tokens &
models](https://squad.so/resources/docs/tokens-models).

**Hezo.** Each agent gets one model (`docs/ai-models.md`). A provider outage raises an
Inbox item so the outage does not sit unnoticed
(`docs/concepts/hiring-and-agents.md:142`) — correct behaviour, but the work stops.

**Tension to resolve first.** `AGENTS.md` § *One mechanism, no silent fallbacks* forbids
exactly this shape: "If the designated mechanism fails, **fail** - loudly." The rule's
own carve-out is "unless the user explicitly asked". An ordered chain the operator typed
into agent settings is that: the operator has named the second mechanism, so falling to
it is the designated behaviour rather than an invented one, and it is not silent if the
run records which model actually ran. Still a deliberate exception to write down, not a
quiet addition. **Ask before building.**

### 7. Read-only share link

**Squad.** Settings → Public dashboard publishes the Mission Control board and every
workspace doc at a share link — no account needed, regenerable (old links die instantly),
indexing off by default. Squad calls it "the cheapest trust artifact you own". [Your team
& shared dashboards](https://squad.so/resources/docs/public-team).

**Hezo.** Nothing equivalent. Note the correction this forces elsewhere: Hezo is *not*
ahead on multi-user. The schema carries `MembershipRole` (`admin`/`member`,
`packages/shared/src/types/common.ts:857`), but there is exactly one human row and no
invite path — the users route comments "List human users (today just the admin)"
(`packages/server/src/routes/users.ts:46`), and the only insert is the superuser
bootstrap (`packages/server/src/services/superuser.ts:28`). Both products are
single-owner today. Both let teammates participate through an allowlisted chat bot
(`docs/chat/overview.md:205`). Squad additionally has the share link.

**Worth doing, small.** A signed, revocable, `noindex` read-only view of one project's
board and docs. Watch the obvious trap: "every doc" is the wrong default for Hezo, where
a project doc can hold anything. Make it opt-in per surface.

### 8. Agents cannot use a browser, or a SaaS without an API

**Squad.** A dedicated cloud computer per squad, with a separate browser profile per
teammate — its own logins and files, separate by default, shareable per connection. The
homepage shows an agent signing itself up for a Trustpilot business account with its own
work email, saving the password to the vault, and signing into X and LinkedIn in a live
session. Squad sells this as "its own reach: signs in where tools usually cannot".
[Homepage](https://squad.so/).

**Hezo.** The agent image ships no browser
(`docker/Dockerfile.agent-base:23-25`). An agent can `npx playwright install-deps` at
runtime — the image grants passwordless sudo for exactly that
(`docker/Dockerfile.agent-base:27-33`) — but nothing persists a logged-in profile
between runs, and dev-server port mapping is not currently supported
(`docs/containers/overview.md:253`).

**Do not chase this without a design.** It collides head-on with Hezo's red line: an
agent run must never contain a confidential value in plaintext, and a browser session
typing a real password into a form is that value in the run. Squad's own answer is
weaker than Hezo's by design — its vault "lives on your squad's own dedicated computer"
and an agent "reads a secret at run time" ([homepage](https://squad.so/)), which is
exactly the materialization Hezo forbids. There may be a narrow version worth having (a
persistent profile directory whose cookies were established by a human, never a password
the agent types), but that is a design exercise, not a backlog item.

### 9. Teach-by-demonstration

**Squad.** "Take over her screen and do the task once while she watches. Clicks and typed
values are captured. Passwords and one-time codes never are." The recording becomes a
written SOP — the homepage demo shows 6 recorded events become 7 written steps, with the
order number lifted into a variable and a $500 threshold flagged for confirmation, every
line editable before approval. [Homepage](https://squad.so/).

**Hezo.** Skills are authored by hand, installed from skills.sh, or proposed by an agent
for approval (`docs/concepts/skills.md:38-48`). There is no capture-from-doing path.

**Note it, do not build it.** It is downstream of #8 — there is no screen to take over
without a browser — and Hezo's skill authoring story is otherwise stronger (scoping,
registry, proposal-with-approval).

## Deliberate differences, not gaps

**Agent email inboxes.** Squad gives each agent a real address on its own or your
domain, with threads, draft-for-review approval at send time, escalations, allow/block
rules, and hard send caps: 100 per rolling 24h per inbox, burst 10/minute and 20 distinct
recipients per 5 minutes, workspace 500/day and 10,000/month. [Agent email, end to
end](https://squad.so/resources/docs/email-guide). Hezo has none of it. This is a large
surface — deliverability, domain authentication, abuse handling, reputation — and it
points at Squad's buyer, not Hezo's. The transferable idea is not email; it is the
**trust ladder**: draft everything in week one, auto-handle the categories that earned
it, keep the gate forever for money and customers
([Safety & control](https://squad.so/resources/docs/safety-control)), with the caps
enforced by the platform rather than asked of the model. Hezo's approvals are binary and
permanent; a graduating gate is a better shape and costs no new surface.

**Research credits.** Squad meters 53 built-in research and scraping tools — web search,
scrapes, SEO data, review pulls, lead enrichment, Lighthouse audits, competitor ads —
against a credit balance ([Costs, caps and what uses
credits](https://squad.so/resources/docs/costs-credits)). Hezo pushes this to the CLI's
own web-search tool plus `curl` and MCP connectors
(`packages/server/src/services/template-resolver.ts:231-232`). For a self-hosted product
with no billing relationship, Hezo's choice is correct. Not a gap.

**Native mobile app.** Squad ships iOS and frames the phone as the decision device
([FAQ](https://squad.so/resources/docs/faq)). Hezo is a mobile-first installable PWA. With
push (#1) that covers most of the same job.

**Onboarding.** Squad's provisioning runs about 5 minutes and ends in a ~10 minute
conversation with the lead agent that sets the squad up with you
([Provisioning](https://squad.so/resources/docs/provisioning)). Hezo has first-run setup
plus project intake. Roughly equivalent.

## Where Hezo is ahead

Worth holding on to while reading the list above.

- **Self-hosted, your keys, no platform fee.** Squad is $99/month plus your model plan.
- **Secrets never enter the run.** Placeholders plus egress-proxy substitution
  (`docs/security/secret-protection.md`). Squad's vault is read at run time on the
  squad's own computer.
- **Per-project container isolation.** One squad, one computer in Squad; one project, one
  sandbox in Hezo.
- **Real repository work with verified commits**, signing key outside the container
  (`docs/security/git-and-verified-commits.md`).
- **Budgets that pause runs and auto-resume**, per agent and per project, plus a
  container-hours ledger. Squad caps only credits and email sends.
- **Org structure as a first-class object** — reporting lines, restructuring mid-project,
  a Coach writing durable rules back onto agents after each finished task.
- **Marketplace teams** that arrive with roster, reporting lines and working rules.
- **MCP in both directions** — drive Hezo from any MCP client, and give agents hosted,
  REST or local stdio connectors.
- **Twelve UI languages.**

## Suggested order

1. Outbound notifications: web push plus proactive chat DM for Inbox items. (#1)
2. Generic agent-raised approval with typed options. (#2)
3. Global Runs view with a failures-today filter. (#4)
4. Per-agent connector scope. (#5)
5. Read-only share link, opt-in per surface. (#7)

Then, each needing a decision first: time-anchored task wake-ups (#3), operator-declared
model fallback chains (#6).

## References

Squad, retrieved 2026-09-13:

- [Homepage](https://squad.so/) — teach-by-demonstration, cloud computer and per-teammate
  browser profiles, per-agent inboxes, vault claims.
- [Pricing](https://squad.so/pricing) — $99/month, what is included, add-on costs.
- [What Squad is](https://squad.so/resources/docs/what-is-mchq) — the five nouns, the six
  surfaces, the supported providers.
- [Missions & the board](https://squad.so/resources/docs/missions-board)
- [Tickets: your decision queue](https://squad.so/resources/docs/tickets)
- [Chat, group chats & the Squad channel](https://squad.so/resources/docs/chat-squad)
- [Agent email, end to end](https://squad.so/resources/docs/email-guide) — the send caps
  and the draft flow.
- [Docs: your squad's shared brain](https://squad.so/resources/docs/docs-guide)
- [Runs: see everything that happened](https://squad.so/resources/docs/runs-guide)
- [Schedules & heartbeats](https://squad.so/resources/docs/schedules-heartbeats)
- [Memory: what the squad remembers](https://squad.so/resources/docs/memory-guide)
- [Skills: capabilities your agents build](https://squad.so/resources/docs/skills-guide)
- [Integrations & secrets](https://squad.so/resources/docs/integrations-secrets)
- [AI tokens & models](https://squad.so/resources/docs/tokens-models)
- [Costs, caps, and what uses credits](https://squad.so/resources/docs/costs-credits)
- [Your team & shared dashboards](https://squad.so/resources/docs/public-team)
- [Notifications](https://squad.so/resources/docs/notifications)
- [When an agent gets stuck](https://squad.so/resources/docs/agent-stuck)
- [Safety & control: what agents can't do](https://squad.so/resources/docs/safety-control)
- [Provisioning](https://squad.so/resources/docs/provisioning)
- [FAQ](https://squad.so/resources/docs/faq) — iOS app, Discord, teammates, cancellation.

Note on naming: Squad was formerly MissionControlHQ, and its support address is still
`support@missioncontrolhq.ai` ([Provisioning](https://squad.so/resources/docs/provisioning)).
The unrelated projects at `trysquad.ai`, `meetsquad.ai` and `github.com/bradygaster/squad`
are different products that also use the name.
