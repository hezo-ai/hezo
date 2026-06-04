# Per-project teams (1:1)

Status: **slices 1–5 implemented** (creation flow, projects-primary rail/home,
refresh-from-type). Remaining follow-up: the first-run **onboarding** migration
so the bootstrap project gets its own team and the HQ team stays CEO-only (open
decision A) — a deeper change to the heavily-tested onboarding flow, scoped at
the bottom of this doc. Pre-v1, no backwards-compat; the DB is reset, not
migrated.

## The shift

Today a **team has many projects**. The target is **one team per project (1:1)**:
each project owns a dedicated team — its roster of agents — and project-type
("team-type") templates make rosters reusable. Projects become the primary axis
of the product; the team is "the people working on this project."

This is a **product + creation-flow + IA** change, not a deep schema rewrite. We
keep the `teams` and `projects` tables and the `projects.team_id` FK; we change
how they're created and presented, and we add a 1:1 invariant.

## Locked model

- **Invariant:** every team has exactly **one user-facing project** (plus its
  `is_internal` project). Creating a project creates its team; the two are 1:1.
  The existing per-team multi-project machinery stays in the code (so nothing
  breaks) but is no longer exposed in the primary UI.
- **The Internal project stays, per project-team.** It remains the Captain's
  coordination space for *that* project — intake, planning hand-off, coherence
  review, hiring. `loadCaptainInternalContext` is unchanged. (So a team still
  physically has two `projects` rows: `(Internal)` + the one user project. "1:1"
  refers to user-facing projects.)
- **Org model unchanged.** One instance **CEO** (seeded once, in the default/HQ
  team, `reports_to = NULL`). Each project-team's **Captain** reports to the CEO
  (cross-team FK, already supported). Members report to their Captain. The CEO
  oversees every project-team's Captain — exactly today's wiring, just with more,
  smaller teams.
- **Reuse via team-types.** At project creation you pick a **type** (a
  `team_templates` row) — `applyTemplateToTeam` seeds the roster additively.
  Later, **refresh-from-type** re-applies the type (additive merge: adds missing
  roles, refreshes built-in prompts, never deletes your customizations).
  **Save-as-type** snapshots a project-team's roster into a new type. All three
  flows already exist (`team-template-apply.ts`, `team-template-snapshot.ts`).

## Creation flow (the heart of the change)

Today: `POST /teams/:teamId/projects` opens an intake ticket in an **existing**
team's Internal project; that team's Captain runs intake → planning.

New primary flow — **"Create a project"** = create a team **and** its project in
one action, reusing the existing pieces in sequence:

1. `createTeam({ name, templateId })` → new team + its Internal project +
   Captain/Coach (from the chosen type), Captain linked to the instance CEO.
   (Existing function, unchanged.)
2. `createProjectIntake(newTeamId, { name, description, initial_prd })` → the
   new team's Captain runs intake/planning for the user project in that team's
   Internal project. (Existing function, unchanged.)

So the change is a thin **orchestration endpoint** (`POST /projects`) +
the UI that drives it — **additive**, not a rewrite. The old
`POST /teams/:teamId/projects` stays for now (used by tests and as the
"add another project to an existing team" escape hatch we simply don't surface).

Naming: the project name **is** the team name by default (the team is "the
Marketing Site team"); the operator can override the team name later in settings.

## IA (projects-primary)

- **Project-scoped sidebar** — *shipped* (`project-sidebar.tsx`): the project's
  pages are primary; the team drops to a secondary "Team" section.
- **Home / far-left rail** — *shipped*. `/home` is the cross-team project list
  (the primary axis); the rail (`team-rail.tsx`) dropped its per-team avatars and
  is now a thin global icon rail (Home / Inbox / All Tasks / New project +
  instance shortcuts). Project-teams are reached via Home / All Tasks.
- **URLs stay team-scoped** (`/teams/$teamId/projects/$projectId/...`) initially —
  teamId still resolves the project's team; a global `/projects/$id` routing
  refactor is out of scope for the first slices.

## Schema

Minimal. `projects.team_id` and the `UNIQUE (team_id, slug)` /
`UNIQUE (team_id, task_prefix)` indexes stay (trivially satisfied with one user
project per team). No migration beyond what's already in `001_initial_schema.sql`.
The 1:1 invariant is enforced in the creation flow / service layer, not by a new
constraint (keeping the multi-project code paths intact and reversible).

## Sequencing (reversible slices, each green + tested)

1. **[DONE]** Combined create-project-with-team endpoint (`POST /api/projects`):
   orchestrates `createTeam` + `createProjectIntake`; returns the new team slug +
   project slug + intake/approval ids. Superuser-gated; additive. Test:
   `server/test/project-with-team.test.ts`.
2. **[DONE]** Create-project-with-team UI: the `CreateProjectWithTeamDialog`
   (type picker + name/description), wired to the **rail "+"** and the **Home
   "New project"** button; navigates into the new team's intake conversation.
3. **[DONE]** Home as project list — the `/home` landing was already a cross-team
   project list (`useAllVisibleProjects`); its "New project" now creates a
   project-with-team.
4. **[DONE]** Rail reshape: per-team avatars dropped; the rail is now a thin
   global axis. Mobile Playwright coverage in `test/browser/team-rail.mobile.spec.ts`.
5. **[DONE]** Refresh-from-type: `POST /teams/:teamId/apply-type`
   (additive `applyTemplateToTeam`) + the `ApplyTypeSection` ("Refresh from
   type") on the team settings page, reachable from the project sidebar's
   Team → Settings. (Built earlier alongside save-as-type.)

### Remaining follow-up — HQ-CEO-only onboarding migration

Open decision A is **HQ is CEO-only**. The rail/Home "New project" already create
separate per-project teams, but the first-run **onboarding** flow
(`services/onboarding-intake.ts`, `onboarding-direct.ts`, `approval-side-effects.ts`)
still creates the bootstrap project inside the default team. Migrating it to the
create-project-with-team path (so the first project also gets its own team and HQ
stays CEO-only) is a deeper change to a heavily-tested first-run flow
(`onboarding*.test.*`, `route-redirects`, `repo-setup-*`) and is the one piece
deferred to its own focused slice.

## Open decisions

- **A. Default team's own project — RESOLVED: HQ is CEO-only.** The default/HQ
  team is the CEO's executive team; its Internal project is where the CEO works,
  and it does not host user projects. Implemented for all new projects (rail/Home
  create their own teams); the first-run onboarding migration is the remaining
  follow-up above.
- **B. Team name vs project name — RESOLVED: team name = project name** by
  default (the create-project-with-team flow names the team after the project);
  editable later in team settings.
- **C. Enforce the 1:1 invariant hard?** Default: **soft** — the primary UI only
  ever creates one user project per team; the multi-project service path stays
  for tests/escape-hatch. Revisit hardening (a DB partial unique index on
  `team_id WHERE is_internal = false`) once the UI no longer creates seconds.
- **D. URL shape.** Keep team-scoped URLs now; global `/projects/$id` is a later,
  separate refactor.
