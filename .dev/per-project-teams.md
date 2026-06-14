# Project-centric model: one team per project (1:1)

Status: **implemented.** Pre-v1, no backwards-compat; the DB is reset, not migrated.

## The model

Hezo is **project-centric**: a **project** is the primary unit, and **every project
owns exactly one team** — its roster of agents. The relationship is **1:1**: a team
backs exactly one project, a project has exactly one team. Conceptually "teams belong
to projects"; in the DB the rows are linked the other way (`projects.team_id` →
`teams.id`), but the invariant is enforced by a `UNIQUE` index on `projects(team_id)`,
so a team can never back more than one project.

There is **no per-team "internal" project.** Every team has a single, user-facing
project. The only `is_internal` project in the entire instance is **HQ** (see below).

Addressing is by **project slug** everywhere (`/api/projects/:projectId/...`, including
project-scoped sub-resources like `/agents`, `/tasks`, `/team`, `/skills`, `/costs`).
A team is reached *through* its project. There is no team-addressed API surface for
project work.

## HQ — the one special team

A single instance-level team, **HQ** (the default team, slug `default`), owns the one
`is_internal` project named **"HQ"**. HQ is the only team with **cross-project powers**.
It hosts exactly two agents, both instance-level singletons:

- **CEO** — one per instance. Oversees every project-team's Captain (cross-team
  `reports_to`). The CEO runs **all coordination**:
  - **Project intake** and **first-run onboarding** — the CEO-assisted creation
    conversation lives in the **HQ project** and is CEO-driven. The project's team and
    Captain are stood up when the intake opens; the project itself is created on approval.
  - **Per-team setup / coherence review / hiring** — these concern a specific
    project-team and live in **that team's own project**, actioned by the CEO. On a
    brand-new team the CEO's initial coherence/setup pass runs first; the Captain's
    planning ticket is **blocked** until it completes.
- **Coach** — one per instance. Reviews completed tickets across **every** project to
  improve agent system prompts; woken on any task completion.

Project-teams created from a **team-type template** (`blank`, `software-development`)
get their own **Captain** plus the template's worker roles. Templates **never** include
the CEO or Coach (instance-level), so a `software-development` roster is 10 agents
(Captain + 9), not 11.

## Cross-team execution (the run-team split)

CEO and Coach are members of HQ but act inside other teams' projects. A run is therefore
scoped to the **task's project team** (the "run team") — JWT, `HEZO_TEAM_ID`, MCP
connections, skills, git identity, container — while the agent's **system prompt** is
loaded from its **home** team (HQ). For an ordinary agent the two coincide. Instance
agents also select work across **all** teams (not just their home team) on heartbeat and
explicit wakeups; the dispatcher realigns the working team to the chosen task's project.

Auth supports this without a membership check: the agent JWT is validated against the
`heartbeat_runs` row `(run_id, member_id, team_id)`, so an HQ member legitimately
operates as a run-team-scoped agent.

## Coordination placement summary

| Work | Lives in | Owned by |
|---|---|---|
| Project intake, onboarding (pre-project) | HQ project | CEO |
| Team setup / coherence review / hiring | the project-team's own project | CEO (cross-team) |
| OAuth verification (creds/connectors are global) | HQ project | CEO |
| Coach review of completed work | the completed task's project | Coach (cross-team) |
| Actual project work (planning, tickets) | the project-team's own project | its Captain + roster |

## Creation flows

There are exactly two ways to create a project; both stand up the project's own
team from a team-type template (default **Blank** = Captain only).

1. **Direct** — `POST /api/projects` (superuser). Creates the team, its single
   project, the Captain, the initial coherence/setup task (CEO), and the planning
   task (Captain, blocked on the coherence task) in one step. Returns the project
   plus `planning_task_id` / `planning_task_identifier`. No approval gate.

2. **CEO-assisted** — `POST /api/project-intakes` (superuser). Stands up the team
   and opens a CEO-run **intake conversation in the HQ project** with a pending
   `project_creation` approval; no project exists yet. The CEO scopes the work with
   the operator, then asks for approval. On approval the server creates the team's
   single project, the initial coherence/setup task (CEO), and the planning task
   (Captain, blocked on coherence), and closes the intake. `GET /api/project-intakes`
   returns the open intake for the home/welcome view.

Both flows also accept a `source_team_id` (mutually exclusive with `template_id`):
the chosen existing team is snapshotted into a fresh, permanent, uniquely-named
team-type template (via `snapshotTeamAsTemplate`) and the new team is provisioned
from it — so cloning a team also seeds a reusable type. The internal HQ team is
rejected as a source (its CEO/Coach must not land in a project roster).

Both the first-run welcome and the ongoing "new project with the CEO" use flow 2's
intake in HQ. The old per-team onboarding/onboarding-intake machinery is gone.

## Key source

- Schema: `001_initial_schema.sql` (`UNIQUE idx_projects_team`).
- HQ seed: `services/teams.ts` `seedDefaultTeam`; CEO/Coach via `ensureInstanceCeo` /
  `ensureInstanceCoach` in `team-template-apply.ts`.
- Coordination context: `services/internal-intake.ts`
  (`loadCoordinationContext` = HQ/CEO; `loadTeamCoordinationContext` = CEO + the team's
  own project).
- Run-team split: `services/agent-runner.ts` (`runTeamId = project.team_id`, prompt from
  home team) and the instance-agent task selection in `services/job-manager.ts`.
