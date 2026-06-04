# Per-project teams (1:1)

Status: **design — locking semantics before implementation.** Pre-v1, no
backwards-compat; the DB is reset, not migrated.

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
- **Home / far-left rail** — the project list becomes the primary axis. The
  rail's per-team avatars become redundant (each "team" is a project) and move
  toward a **project list** instead. *Deferred to a later slice* — it's the most
  test-affecting and needs the creation flow first.
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

1. **Combined create-project-with-team endpoint + service** (`POST /projects`):
   orchestrates `createTeam` + `createProjectIntake`; returns the new team slug +
   project slug + intake/approval ids. Server test: one call yields a new team
   (Captain → CEO) with its Internal project and a user-project intake. *Additive;
   nothing existing changes.*
2. **Create-project-with-team UI**: a "New project" dialog (type picker from
   `setup/direct-flow` + name/description) that calls `POST /projects` and
   navigates into the new project. Wire it to the projects-primary entry points.
3. **Home as project list**: surface all project-teams as the primary axis
   (cross-team project list), keeping the team rail until slice 4.
4. **Rail reshape**: replace per-team avatars with the project list / thin global
   rail. Most test-affecting — do last, with Playwright mobile coverage.
5. **Refresh-from-type** on the project-team settings (apply-type button →
   additive re-apply), surfaced in the project sidebar's Team → Settings.

## Open decisions (resolve at review)

- **A. Default team's own project.** The default/HQ team hosts the instance CEO
  and (today) a user project. Does the HQ team get a user project, or is it
  CEO-only (HQ becomes an executive team with just the Internal project)? Default:
  **HQ is CEO-only** — cleaner separation; its Internal project is where the CEO
  works.
- **B. Team name vs project name.** Default to **team name = project name**;
  editable later. (Locked above, flag for confirmation.)
- **C. Enforce the 1:1 invariant hard?** Default: **soft** — the primary UI only
  ever creates one user project per team; the multi-project service path stays
  for tests/escape-hatch. Revisit hardening (a DB partial unique index on
  `team_id WHERE is_internal = false`) once the UI no longer creates seconds.
- **D. URL shape.** Keep team-scoped URLs now; global `/projects/$id` is a later,
  separate refactor.
