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

Today: `POST /projects/:projectId/projects` opens an intake ticket in an **existing**
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
`POST /projects/:projectId/projects` (sibling-create on any project of the team)
stays for now (used by tests and as the "add another project to an existing
team" escape hatch we simply don't surface).

Naming: the project name **is** the team name by default (the team is "the
Marketing Site team"); the operator can override the team name later in settings.

## IA (projects-primary)

- **Project-scoped sidebar** — *shipped* (`project-sidebar.tsx`): the project's
  pages are primary; the team drops to a secondary "Team" section.
- **Home / far-left rail** — *shipped*. `/home` is the cross-team project list
  (the primary axis); the rail (`team-rail.tsx`) dropped its per-team avatars and
  is now a thin global icon rail (Home / Inbox / All Tasks / New project +
  instance shortcuts). Project-teams are reached via Home / All Tasks.
- **URLs are project-centric** (`/projects/$projectId/...`) — *shipped*. The
  project slug is the single public handle across the browser URL, the REST API
  (`/api/projects/:projectId/...`), and the query/realtime layer; the backing
  team is resolved from the project, never named in the URL. Project slugs are
  globally unique (incl. internal projects, slug `internal-<teamSlug>`). Team
  pages (Agents, Inbox, team settings) nest under the project; onboarding —
  being pre-project — is addressed via the active team's internal project.
  Breadcrumbs carry only the in-project section + leaf (no team or project-name
  crumb). See the routing middleware `requireProjectAccessMiddleware`.

## Schema

Minimal. `projects.team_id` stays. Project `slug` is **globally unique**
(`UNIQUE INDEX idx_projects_slug ON projects(slug)`) so a project resolves to its
team without naming the team in the URL; `task_prefix` stays `UNIQUE (team_id,
task_prefix)`. Both are trivially satisfied with one user project per team. No
migration beyond what's already in `001_initial_schema.sql`. The 1:1 invariant is
enforced in the creation flow / service layer, not by a new constraint (keeping
the multi-project code paths intact and reversible).

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
5. **[DONE]** Refresh-from-type: `POST /projects/:projectId/apply-type`
   (additive `applyTemplateToTeam`) + the `ApplyTypeSection` ("Refresh from
   type") on the team settings page, reachable from the project sidebar's
   Team → Settings. (Built earlier alongside save-as-type.)

### First-run onboarding (HQ-CEO-only)

Open decision A is **HQ is CEO-only**. Status:

- **[DONE] Direct flow** (the prominent "Pick a template" path). `runOnboardingDirect`
  now provisions the project's **own team** (named after the project, Captain →
  CEO) and creates the project + planning task there; the wizard navigates into
  the new team. The default/HQ team is left untouched. Home recognises onboarding
  completion across all visible teams and only opens an intake during true
  first-run. Tests: `web/test/onboarding-direct.test.tsx` (rewritten).
- **[DONE] Captain-chat flow** (the "Chat with the Captain" option). Rerouted to
  the project-with-team dialog: it now creates the project's own team and the
  Captain scopes it in that team's `project_creation` intake thread — reusing the
  tested `POST /api/projects` flow rather than reworking the core
  `approval-side-effects` path. So **neither onboarding path lands a user project
  in the default team**. The legacy home onboarding-intake panel +
  `onboarding-intake.ts` machinery stay intact (API-reachable + tested) but are no
  longer triggered by the first-run UI.

**Optional cleanup (not done):** `seedDefaultTeam` still seeds the default/HQ team
with a bootstrap Captain + Coach (from the Blank template) alongside the CEO.
HQ no longer hosts user projects (so this is invisible in the projects-primary
UI), but stripping HQ to a literal CEO-only roster would be a `seedDefaultTeam`
change with startup/seed-test blast radius — left as an optional follow-up.

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
- **D. URL shape — RESOLVED: project-centric, shipped.** Browser URLs, the REST
  API, and the query/realtime layer all key on the globally-unique project slug
  (`/projects/$projectId/...`); the backing team is resolved from the project and
  never named in the URL.
