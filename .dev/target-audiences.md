# Target audiences — App Team, Influencer, Investment

Planning document for expanding Hezo from a single implicit audience (software
teams) to three explicitly targeted audiences, each with its own team template
in the product and its own subpage on the website. Written 2026-07.

**Status: the product side is implemented — as marketplace teams** (the team
marketplace landed after this doc was written, so the delivery mechanism moved
from seeded DB templates to the marketplace). What actually landed, and where
it differs from the original plan below:

- **Three marketplace teams** (each an `agents/<team>/team.json` manifest +
  role `.md` prompt bodies, compiled to committed `marketplace/teams/<slug>.json`
  by `build:marketplace`): **App Team** (slug `software-development`, display
  name renamed from "Startup" — a content change, no migration needed since
  marketplace teams are never persisted as `team_templates` rows),
  **Influencer Marketing** (slug `influencer`), and **Investment** (slug
  `investment`). Running instances pick them up from the live catalog without
  a binary upgrade.
- **Goals: the Captain/CEO *suggest* goals, the admin approves.** Not direct
  creation — `suggest_goal` (MCP) files a `goal_suggestion` approval (enum
  migration `038`) that surfaces as an Approve/Deny card on the task thread,
  the project Goals page, and the admin inbox (`goalSuggestionHandler` creates
  the real goal on approval).
- **Per-template onboarding Q&A** lives in each team's `captain.md`: the
  Influencer captain asks accounts/persona/brand/3-6-12-month goals; the
  Investment captain asks stocks/objective/risk-appetite/horizon; the App Team
  captain scopes (spec? deployment? one-vs-many apps? constraints?) instead of
  assuming build-and-deploy.
- **Content-approval gate is prompt-level** (role prose + the stop-hook
  convention, admin toggles via team preferences) — no new hard interlock.
- **Investment daily monitoring** rides goals + a standing watch task +
  `catalyst-monitor`'s daily heartbeat — no new scheduler.
- **Create-project flow**: marketplace teams appear in the standard
  create-project dialog (and the Marketplace pages' "Launch new project"), so
  the new teams needed no dialog changes.
- **The website subpages (`/for/*`) are NOT built yet** — still to do in the
  `hezo-ai/website` repo (see §4 below).

The audience/roster analysis below is retained as the design reference.

**Decision up front:** we target exactly three audiences, chosen to span
builder / creator / analyst — three very different buyer profiles that also
stress-test the template system's generality:

1. **App team** — the existing software-development template, repositioned and
   renamed. The pitch shifts from "a software engineering team" to "the team
   that builds your app": anybody wants to build apps, not just professional
   developers.
2. **Influencer** — a new template for growing social-media clout and reach:
   strategy, ready-to-post content, trend research, distribution, analytics.
3. **Investor** — a new template for research-grade information on stocks and
   what to invest in, plus ongoing tracking of a portfolio/watchlist.

Each audience ships as a **pair**: a team template in the create-project picker
and a matching `/for/<audience>` page on hezo.ai. The governing rule is that
**the page promises exactly the team the picker provisions** — same roster,
same week-one deliverables — so the website is never ahead of or behind the
product.

## Why these three

The selection criterion is *very immediate impact*: the agent team must produce
its core deliverable end-to-end inside a Hezo container, with a clear day-one
output the user can judge without waiting on integrations.

- All three audiences' deliverables are text/web/code-native — an app, a
  content calendar full of ready-to-post material, a cited research report.
  Agents produce these autonomously; no physical-world or heavy-integration
  dependency blocks the first win.
- Each has an obvious first-session "wow": the App team ships a working
  prototype; the Influencer team returns a niche analysis and a week of posts;
  the Investor team returns a research-grade write-up on a ticker the user
  names.
- Together they cover the three broad self-serve personas — people who want to
  **build**, people who want to **be seen**, people who want to **grow money**
  — without overlapping each other, which keeps the website's audience
  navigation simple (three doors, pick yours).

Audiences considered and deferred (revisit after these three land): content
marketing for companies (subset of Influencer mechanics, B2B messaging),
research/analysis teams (subset of Investor mechanics, generic domain),
sales/outbound, e-commerce operations.

## Audience 1 — App team (rename + repositioning of Startup)

**Who:** founders, indie hackers, small businesses, and non-engineers with an
app idea — as well as actual developers. The current template name ("Startup")
and docs framing ("full software-development team") speak to people who already
think in engineering-org terms. The repositioning says: *you describe the app,
your team builds it*.

**Week-one output:** a working app — repo, running prototype, deployed preview
— plus a product plan the user can steer without knowing how to read code.

**Roster:** unchanged. The existing 10 roles in `agents/software-development/`
(captain, product-lead, architect, engineer, qa-engineer, security-engineer,
ui-designer, devops-engineer, marketing-lead, researcher) already are an
app-building team; this audience needs a rename and new messaging, not new
prose. A light editing pass over the role docs for jargon is optional polish,
not a blocker.

**Rename scope (Startup → App Team).** Smaller than it looks, with one real
wrinkle:

- Display name: the `team_templates` INSERT in
  `packages/server/src/db/seed.ts` (the `'Startup'` literal and its
  description) and the `teams.Startup` key in
  `packages/server/src/db/agent-summaries.json`.
- **Upgrade wrinkle — the upsert conflicts on `name`.** The seed uses
  `ON CONFLICT (name) DO UPDATE`, so simply changing the literal would leave an
  existing instance with a stale "Startup" row *and* a new "App Team" row. The
  rename therefore needs a migration (data-preserving, per the migrations
  policy: `UPDATE team_templates SET name = 'App Team' WHERE name = 'Startup'
  AND is_builtin`, plus its `migrate-<NNN>-*.test.ts`) — or the template rows
  need a stable machine key independent of display name. The migration is the
  cheaper path; a stable `slug` column on `team_templates` is the better
  long-term fix if we expect more renames.
- Directory name: keep `agents/software-development/` as-is. `role()` and
  `defaultTeamContextFor()` in `seed.ts` hard-code that path, the partials and
  a large test surface reference it, and it's not user-visible. Renaming the
  dir buys nothing.
- Tests: many server tests and the browser helpers provision by the literal
  template name (`test/browser/helpers.ts`, `run-trigger-reason.spec.ts`, a
  dozen-plus files under `packages/server/test/` — grep `'Startup'`). Introduce
  a shared constant for the built-in dev-template name in
  `packages/shared/src/constants.ts` (next to `DEFAULT_TEAM_TEMPLATE_NAME`,
  which stays `'Blank'`) and migrate tests to it as part of the rename.
- Docs: `docs/concepts/projects-and-teams.md` ("### Startup team", "Named
  **Startup** in the template picker"), `docs/concepts/team-structure.md`, and
  the `list_team_templates` tool description that surfaces in the generated
  `docs/reference/mcp-api.md` (edit the tool description in
  `packages/server/src/mcp/tools.ts`, then `bun run build:docs`).

## Audience 2 — Influencer (new template)

**Who:** individual creators and personal brands who want to grow reach —
YouTube/TikTok/X/LinkedIn/newsletter — and are currently doing strategy,
writing, editing, research, and posting alone.

**Week-one output:** a niche/positioning analysis, a content strategy with
pillars, a filled two-week content calendar, and a batch of ready-to-post
material (threads, scripts, captions, a newsletter draft) in the user's voice.

**Roster sketch** (dir `agents/influencer/`, ~6 roles — final prose to be
written at implementation):

| Role (slug) | Owns |
|---|---|
| captain | Translates the creator's goals into strategy and priorities; delegates; the creator's single point of contact (template-specific prompt) |
| content-strategist | Niche, positioning, content pillars, the calendar; decides *what* gets made and *why* |
| writer | Drafts everything: scripts, threads, captions, newsletters — in the creator's voice |
| editor | Voice consistency, hooks, platform fit; quality gate before anything is handed to the creator |
| trend-researcher | Trend and audience research, competitor/creator analysis, topic mining; feeds the strategist |
| engagement-manager | Distribution: cross-posting plans, reply/community strategy, collab outreach drafts, and the analytics review loop that feeds performance learnings back to the strategist |

**Why immediate impact works here:** everything above is text the agents
produce in-container. Publishing and analytics are *human-in-the-loop* at
first (the creator posts the material) with a clear upgrade path: Typefully is
already a known MCP connector shape for scheduling/drafting, and per-platform
credentials flow through the standard `request_credential` / connector
machinery — no new infrastructure.

**Gaps to flag in role prose and on the page:**

- Media production: agents write scripts and captions; they don't shoot video
  or produce final images. The page must promise "your writing/strategy/research
  team", not "your video editor".
- Platform APIs for auto-posting/analytics vary in openness; the template works
  fully without them (creator posts manually), connectors make it better.

## Audience 3 — Investor (new template)

**Who:** individual investors and small funds/family offices who want
research-grade analysis — the kind an analyst team produces — on stocks and
markets, plus continuous tracking of what they hold and watch.

**Week-one output:** a cited, research-grade write-up on tickers the user
names (business, financials, valuation context, bull/bear case, risks), a
structured watchlist, and standing tasks that keep it current.

**Roster sketch** (dir `agents/investor/`, ~6 roles):

| Role (slug) | Owns |
|---|---|
| captain | Translates the investor's goals/mandate into research priorities; template-specific prompt |
| market-researcher | Screens, sector and thematic research; sources candidates for the analyst |
| equity-analyst | Fundamental deep-dives and valuation write-ups; the core deliverable |
| macro-monitor | Macro, rates, and news monitoring; runs the recurring watchlist-review tasks |
| risk-officer | Adversarial review: challenges every thesis, verifies claims and citations, tracks portfolio-level risk/concentration |
| portfolio-reporter | Maintains the portfolio/watchlist state as project documents; produces the periodic (weekly/monthly) review reports |

**Why immediate impact works here:** research over public information is
exactly what agents do well end-to-end, and Hezo's recurring-wakeup/task model
maps directly onto "keep watching my list" — the monitoring roles are standing
tasks, not one-shots. The risk-officer role bakes adversarial verification into
the team structure, which is what makes the output "research-grade" rather than
"an LLM's opinion".

**Gaps to flag in role prose and on the page:**

- **Not financial advice.** The role prose must frame every output as research
  and analysis, never as a directive to buy/sell, and the website page carries
  an explicit disclaimer. This posture is decided now, not at implementation.
- Market-data access: week one runs on public web sources. Real-time or
  licensed data (quotes APIs, filings services) arrives later via connectors /
  `request_credential` with `allowed_hosts` scoping — the template must be
  honest that it is not a live terminal.
- Brokerage integration is explicitly out of scope: the team tracks what the
  user tells it (or documents it maintains), it never touches accounts.

## Implementation — team templates (hezo repo)

What shipping a new template involves. The provisioning, REST, MCP, and web
picker layers are all data-driven off `team_templates` /
`team_template_agent_types`, so a new seeded template needs **no changes** in
`team-template-provision.ts`, `routes/team-templates.ts`, the picker
(`packages/web/src/components/create-project-with-team-dialog.tsx`), or CEO
intake (`services/project-intake.ts` already tells the CEO to call
`list_team_templates` and recommend the best fit — new templates improve that
recommendation for free).

Per new template (Influencer, Investor):

1. **Role prose:** `agents/<template-dir>/*.md`, one file per role. The
   template-specific Captain prompt rides in the template row's
   `builtin_agent_prompts` / `builtin_agent_team_contexts` jsonb (the mechanism
   `blank/captain.md` already uses) — the `captain` agent-type row itself stays
   as-is.
2. **Partials audit:** most of `agents/_partials/common/` is domain-neutral
   (tasks, goals, budgets, documents-and-memory, subagent-usage, …) and should
   be reused; `code-quality-principles.md`, `delivery-knowledge.md`, and
   `no-designated-repo.md` are software-shaped — check each, and write new
   domain-neutral partials only where two-plus roles in these templates share
   guidance. Rebuild with `bun run build:agents`.
3. **Seeding (`packages/server/src/db/seed.ts`):** new role defs in
   `buildAgentTypeDefs()` (slug, `reports_to_slug`, `sort_order`, effort,
   budgets, `touches_code: false` for every new role — none of them write
   code); a new `team_templates` INSERT and a `team_template_agent_types` loop
   per template. **Generalize the hard-coded dir first:** `role()` and
   `defaultTeamContextFor()` (seed.ts ~lines 194–201) assume every non-coach
   role doc lives under `software-development/` — they need a slug→template-dir
   mapping before a second roster dir can seed.
4. **Companion summaries (`packages/server/src/db/agent-summaries.json`):**
   `agents.<new-slug>` per role, `teams.<Template Name>` per template,
   `team_contexts.<template-dir>.<slug>` per role.
5. **Starter skills:** the Startup template ships a `skills_config` starter
   skill ("Development Workflow"); give each new template an equivalent (e.g.
   a content-workflow skill for Influencer, a research-report-format +
   watchlist-cadence skill for Investor). Global defaults in `skills/` stay
   domain-neutral by rule — audience-specific workflow prose belongs in the
   template's `skills_config`, not the global catalog.
6. **`touches_code: false` check:** verify what that flag gates (repo/git
   wiring, engineer-shaped run expectations) and confirm an all-non-code team
   provisions and runs cleanly — the Blank template is precedent that a team
   without coding roles works, but these are the first *worker* rosters without
   any `touches_code` role.
7. **Upgrade behaviour:** `seedBuiltins` runs at startup with
   `ON CONFLICT ... DO UPDATE`, so new templates appear on existing instances
   after upgrade automatically — verify, and note it in release notes.
8. **Docs (same PR as implementation):** new roster sections in
   `docs/concepts/projects-and-teams.md` and `docs/concepts/team-structure.md`;
   `.dev/architecture.md` §4 (template list); the `list_team_templates` tool
   description + `bun run build:docs`. Guarding tests to keep green:
   `agent-roles.test.ts`, `resolve-partials.test.ts`,
   `agent-prompt-required-vars.test.ts`, `startup-seed-failure-paths.test.ts`,
   `docs-bundle.test.ts`, `mcp-reference.test.ts`.

## Implementation — website (hezo-ai/website repo)

The site is Gatsby 5; docs already come from this repo via the `vendor/hezo`
submodule, but the audience pages are marketing pages that live in the website
repo itself. There is currently **zero** persona content — this is greenfield.

- **Pages:** `/for/app-builders`, `/for/influencers`, `/for/investors`
  (`app-builders` matches the "App Team" name better than `developers`; final
  slugs are an open question below). Recommended shape: one shared
  `src/templates/audience.tsx` + a single audience data file, generated via
  `createPages` in `gatsby-node.js` — the same pattern `doc.tsx` /
  `news-article.tsx` use, and adding a fourth audience later becomes a data
  edit. (Three static files under `src/pages/for/` would also work; the shared
  template keeps the three pages structurally identical, which the messaging
  rule below wants anyway.)
- **Per-page structure:** audience hero ("Your app team" / "Your content team"
  / "Your research team"), *what your team ships in week one* (the outputs
  listed per audience above), a roster showcase that mirrors the template's
  roles one-for-one, an audience-specific FAQ, and the install CTA (reuse the
  homepage's install-pill; `src/components/Pillars.js` is an existing unused
  component worth repurposing for the roster grid). The Investor page carries
  the not-financial-advice disclaimer.
- **Messaging rule:** each page's roster and promises mirror exactly what the
  template provisions. When a template's roster changes, the page changes in
  the same release.
- **Wiring:** nav links (or a "For…" dropdown — `@radix-ui/react-popover` is
  already a dependency) in `src/components/Nav.js`, in *both* the desktop
  `.nav-right` block and the mobile `.nav-menu` block; a column or link group
  in `src/components/Footer.js`; homepage cross-links — likely a small
  "Who is Hezo for?" three-card section on `src/pages/index.js` linking the
  three pages, while the hero itself stays audience-neutral (open question
  below).
- **SEO:** per-page `Head` via `src/components/Seo.js` with `title`,
  `description`, and `pathname` (canonical), plus `BreadcrumbList` and
  `FAQPage` JSON-LD passed as children — copy the `news-article.tsx` pattern,
  the richest on the site. Sitemap inclusion is automatic (`onPostBuild` in
  `gatsby-node.js` includes every built page); `static/llms.txt` is **manual**
  — add the three pages there.

## Rollout

Each phase is independently shippable; nothing blocks on anything outside its
own row.

1. **Phase 1 — reposition what exists:** Startup → App Team rename (with the
   `ON CONFLICT (name)` migration) + all three website pages. The Influencer
   and Investor pages can ship "join the waitlist"-free and honest — worded
   around what the Blank template + hiring can already do — or ship in phase 2
   alongside their templates if we don't want any gap between page and picker.
   Given the messaging rule above, **shipping each page with its template is
   the safer default**; phase 1 then delivers the rename + the App Team page.
2. **Phase 2 — Influencer template** + `/for/influencers` page. Includes the
   `role()`/`defaultTeamContextFor()` generalization in seed.ts (first second-
   roster template pays that cost).
3. **Phase 3 — Investor template** + `/for/investors` page. Can run in
   parallel with phase 2 once the seed.ts generalization lands.

## Open questions

- Final display names in the picker: "App Team" vs "App Builder" vs keeping a
  product-flavored name; and whether "Blank" gets an audience-neutral gloss.
- Final URL slugs: `/for/app-builders` vs `/for/developers` (SEO pull of
  "developers" vs message fit of "app"); singular vs plural for
  `/for/influencers` / `/for/investors`.
- Homepage hero: stays audience-neutral with a three-door section, or becomes
  an audience switcher. Recommend neutral + three-door first; it's reversible.
- Market-data sourcing for the Investor team: which providers to bless as
  first-class connectors, and when licensed data is worth the setup friction.
- Whether `team_templates` should grow a stable machine-key `slug` column
  (would make this and future renames trivial and give the website a stable
  identifier to reference rosters by).
- Whether any new-audience guidance is broad enough to belong in
  `SHARED_INSTRUCTIONS` (`template-resolver.ts`) rather than per-role prose —
  default no; it must stay domain-neutral since it reaches every agent on
  every team type.
