# Authoring a marketplace team

The contributor guide for content that ships to other people: marketplace teams and the
default skills catalog. For how a team is provisioned at runtime see `architecture.md` § 4
(*Team marketplace*). The rules that bind before you start - prompts are the single source of
truth, regenerate and commit the generated JSON in the same change, no Hezo symbol or path in
a file that ships into someone else's repository - are in `AGENTS.md`.

## Marketplace teams

- **Team marketplace** (`marketplace/`, `agents/<team>/team.json`). Prompt bodies stay in `agents/<team>/*.md`; roster and metadata (name, description, summary, `keywords`, per-role slug/reports_to/effort/budgets/role_description/summary/team_context, `changelog`) live in a hand-authored `team.json`. A marketplace team ships only roster + prompts — no bundled skills, MCP servers or MPP config.
  - **`keywords` is the discovery vocabulary** — the words someone would type when they want this team. The New Project picker ranks against them above the team's own name, so make a team findable for a new phrasing by adding the phrasing, never by teaching the matcher about that team. Author readable words and phrases, not stems (`extractTerms`/`stemTerm` in `@hezo/shared` stem both sides); be generous with variants the stemmer won't fold ("code" *and* "coding"). Keywords are excluded from the content hash, so retuning them does not bump `version`.
  - `bun run --cwd packages/server build:marketplace` regenerates the committed JSONs — run it after editing any `agents/<team>/` prompt or `team.json`, **or any `agents/_partials/` file a team role resolves** (`bun run dev` does it automatically). It auto-increments `version` on a content-hash diff (excluding version/changelog/keywords); add a `changelog` entry per bump. **Commit the regenerated `marketplace/teams/*.json` + `index.json`** — production fetches them from GitHub raw, and `marketplace-build.test.ts` fails on a stale or missing file. It is deliberately outside `bun run build`, so a local build passes with the JSONs stale and only CI catches it.
  - `build:teams` bundles the committed JSONs into the gitignored `teams-bundle.json`, the offline fallback only. At runtime `services/marketplace.ts` prefers the repo folder in dev (`HEZO_MARKETPLACE_DIR`), then GitHub raw (`main`, then `master`), then the bundle.
  - Only the **Blank** template is seeded into the DB. Marketplace teams are never persisted as `team_templates`/`agent_types` rows — they are provisioned directly with `agent_type_id` null. Launch from one via `POST /api/projects {marketplace_slug}`; add to an existing project via `POST /api/projects/:projectId/marketplace-team`.

## Default skills

- `skills/<slug>.md` — the default global skills (flat dir, filename = slug; frontmatter `name`/`description`/optional `source_url`), bundled by `build:skills` into `skills-bundle.json`. A fresh instance auto-installs the catalog on first boot (`installDefaultSkillsIfFreshInstance`, before `seedDefaultTeam`, gated on HQ not existing); an upgrading instance is **not** auto-seeded — the operator installs missing ones from the global Skills page (`GET /api/skills/defaults`, `POST /api/skills/defaults/install`). A per-slug `system_meta` marker (`default_skill_shipped_hash:<slug>`) prevents re-offering a deleted default or clobbering a user-owned same-slug skill. Keep `skills/ATTRIBUTION.md` accurate (it's excluded from the bundle). Content rules: domain-neutral where the category allows, single self-contained document, short `description`, "task" never "ticket". `default-skills.test.ts` enforces the mechanical half; domain-neutrality is on you.
