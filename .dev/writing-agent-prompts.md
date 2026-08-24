# Writing an agent prompt

The contributor guide for authoring agent-facing prose - `SHARED_INSTRUCTIONS`, the `agents/` role docs and partials, the shipped skills, and any prompt a CEO/Captain/Coach writes at runtime. The rules that bind before you start - one rule per bullet, state it once in the highest-reaching surface, no Hezo internals in a marketplace-reaching file - are in `AGENTS.md`; this is the how, and the why.

The register is **ASD-STE100 (Simplified Technical English)** adapted for LLM system prompts, plus Zinsser's four principles: simplicity, brevity, clarity, humanity. `agents/influencer/content-writer.md` is the reference doc. Read it before you write, and read your finished doc beside it.

## Why this exists

The corpus reached ~53,000 words by accretion. Every incident added a paragraph and no pass ever removed one, so the same rule ended up stated four, eight, fourteen times in different words. That is not merely long. It is a correctness problem:

- `qa-engineer.md` told QA that the Engineer merges each phase to the default branch. `engineer.md` forbade exactly that in five places. Two roles at either end of one handoff held opposite models, because each kept its own copy of a shared protocol.
- `SHARED_INSTRUCTIONS` § @-Mentions spent 4,752 words re-deriving one rule ("who must act next on this task decides active vs passive") fourteen times. A reader cannot tell which of the fourteen is the rule and which are commentary.

Every duplicated rule is a rule that will one day be updated in one place only.

## Where a rule goes

Decide reach first, then write. This is `AGENTS.md` § *Layout* (where guidance goes, by reach) turned into a writing step:

| Audience | Home |
|---|---|
| Every agent, now and future, on every run | `SHARED_INSTRUCTIONS` (`services/template-resolver.ts`) |
| A subset of seeded roles | `agents/_partials/<group>/<name>.md` |
| One role | that role's `agents/<team>/<role>.md` |
| Loaded on demand, when the task calls for it | a skill in `skills/` |

Three consequences people get wrong:

- **A role doc never restates `SHARED_INSTRUCTIONS`.** It may name the rule in one clause to hang a role-specific exception on it. It never re-teaches the mechanic.
- **A `Responsibilities` list never restates the `Task workflow` below it.** Responsibilities are standing scope - what this role owns. The workflow is the sequence. If a bullet describes a step, it belongs in the workflow and nowhere else.
- **Partials are baked, not resolved at runtime.** By the time a prompt reaches `resolveSystemPrompt`, `{{> partials/...}}` is gone. A partial included by five role docs ships five copies in `marketplace/teams/<slug>.json`, so a wordy partial costs five times what it looks like.

## The register

### Shape

- **One rule per bullet.** Two rules means two bullets.
- **One idea per sentence, 25 words maximum.** STE says 20; placeholders and tool names inflate the count without adding clauses.
- **About 60 words per bullet, maximum.** Longer means a rule is hiding inside prose. Split it or cut it.
- **The bold lead is the rule and must read alone.** Everything after it is exception, mechanism, or consequence. If the lead needs the body to be understood, the lead is wrong.
- **Default first, then the exception, then the failure mode.** Never open with the trap.
- **One topic per `###` section.** Two sections answering one question get merged.
- **Four or more parallel items become a table.** A table carries more information per word than any prose form.

### Words

- **Imperative, second person, active voice.** "Post the active `@<slug>`", not "the active mention should be posted".
- **One term per concept, forever.** *task* (never ticket or issue), *admin* (never user or operator), *run*, *heartbeat*, *wake*, *active/passive mention*, *slug*, *teammate*, *direct report*. A synonym reads as a new concept.
- **One modality.** A bare imperative means must. `Never` marks a prohibition. Delete `should`, `must`, `non-negotiable`, `mandatory`, `hard musts, not aspirations`. Write "the server rejects this" only where it actually does, and name what rejects it.
- **No hedges** - `generally`, `usually`, `typically`, `tends to`, `it is worth noting`.
- **No intensifiers that carry no constraint** - `aggressively`, `genuinely`, `actually`, `simply`, `just`, `very`, `thoroughly`, `comprehensive`. Replace "be thorough" with the observable behaviour you want.
- **No rationale unless the rule cannot be applied without it.** Cut `because`, `the reason is`, `what disguises it is`, `it looks careful on its own`. Rationale belongs in this file.
- **One consequence clause per rule.** "A passive `@@` wakes nobody and the task stalls" is worth saying once.
- **Repeat the noun.** Never carry a `this`, `that` or `it` across a sentence boundary.
- **Name the thing.** `update_task`, not "the update mechanism". The tool, the field, the status value, the exact string.

### Examples

- **Keep an example only when it supplies a literal string the agent must reproduce** (`@<slug> - <ask>`, `git push origin HEAD:hezo/<TASK>`, `blocked_by_task_ids: ['#0']`) **or separates two cases the rule alone cannot.**
- **Delete every example that only re-illustrates its rule.**
- **One counter-example per rule, and only where the wrong output is string-shaped and predictable** - `@@<slug> - ` opening a line, a backticked doc filename, `model:` on a sub-agent launch. Never a conceptual counter-example.

## Where we depart from ASD-STE100, and why

STE was written so a non-native mechanic cannot misread an aircraft manual. An LLM has a different failure mode: it does the **salient** thing rather than the **stated** thing. Five deliberate departures follow from that.

1. **Keep negative constructions.** STE bans them. A bare positive rule does not foreclose the wrong action - a model told "address a teammate with `@<slug>`" will still open a line with `@@<slug> - `. The pattern is a positive imperative followed by one `Never` clause, not a paragraph of negatives.
2. **Keep one counter-example where the model predictably emits the wrong string.** STE forbids them because a reader may copy the wrong one. In context, a labelled wrong form suppresses it. The discipline is *one*, *labelled*, *string-shaped*.
3. **Keep the consequence clause, once.** STE strips outcome statements as rationale. Here the consequence is the discriminator for an ambiguous case: "wakes nobody and the task stalls" tells the model which branch to take.
4. **25-word sentences, not 20.** Tool names and `{{placeholders}}` eat the budget without adding clauses.
5. **Ignore STE's ban on the gerund-as-noun and its article rigidity.** Both make English prompts read like machine translation, which costs more in Zinsser's humanity than it buys in clarity.

What we do **not** relax: one term per concept is STE's highest-value rule, and this corpus violated it constantly.

## No Hezo internals in a marketplace-reaching file

`agents/<team>/**`, and any partial reaching one, ships into **other people's repositories** through the marketplace. Naming `withTransaction`, `requireTeamAccess`, `trackBackground`, `createStubDocker`, `PGlite`, `renderApp()`, `isFkViolation` or `packages/shared/` there is an instruction to look for something that does not exist. State the general shape the symbol illustrated instead, and delete the precedent entirely - a precedent is rationale.

Two things are not Hezo internals and stay:

- **`AGENTS.md` as a generic reference** ("read the repo's AGENTS.md for conventions"). Real in any repo.
- **`hezo/<TASK>` branch naming.** That is Hezo's runtime behaviour, not this repo's convention. Load-bearing everywhere.

## Editing a prompt without losing a rule

Roughly 324 test assertions quote prompt prose byte-for-byte - about 174 against `SHARED_INSTRUCTIONS` and 150 against role docs. **Treat that set as the rule inventory.** The invariant:

> Every assertion string removed from a test must be replaced, in the same commit, by a new string asserting the same rule. A deleted assertion with no replacement means a rule was lost.

Make it countable:

```sh
git show origin/main:packages/server/test/template-resolver.test.ts \
  | grep -oP "toContain\(\s*['\"]\K[^'\"]{8,}" | sort -u > /tmp/assert-before.txt
grep -oP "toContain\(\s*['\"]\K[^'\"]{8,}" packages/server/test/template-resolver.test.ts \
  | sort -u > /tmp/assert-after.txt
comm -23 /tmp/assert-before.txt /tmp/assert-after.txt   # each line needs a stated replacement
```

**The behaviour-token inventory** is the second net. Every backticked token in the corpus is a tool name, status value, field, slug, placeholder or flag; one that vanishes is a candidate lost behaviour.

```sh
tokens() { { sed -n '45,295p' "$1/packages/server/src/services/template-resolver.ts"
             find "$1/agents" -name '*.md' -exec cat {} +; } | grep -o '`[^`]\+`' | sort -u; }
git worktree add /tmp/hezo-base origin/main
comm -23 <(tokens /tmp/hezo-base) <(tokens .) > /tmp/tokens-lost.txt
```

Every line gets a justification or goes back in.

**Grep for removed prohibitions.** STE prose is crisp and can quietly turn "never" into "prefer". Scan the diff for every dropped `Never` and confirm a surviving equivalent.

## Shipping the change

- **`agents/<team>/**` or a partial reaching one** - run `bun run --cwd packages/server build:marketplace` and commit the regenerated `marketplace/teams/*.json` plus `index.json` in the **same commit**, or `marketplace-build.test.ts` goes red. The version auto-bumps by one per content-hash diff; author a real `changelog` entry in `agents/<team>/team.json` or the builder inserts an empty stub. `_partials/captain/*` reaches all three teams plus blank.
- **`_instance/*` or `blank/captain.md`** - `bun run build` regenerates the gitignored `agents-bundle.json`. Nothing to commit.
- **An MCP tool description** - rebuild `docs/reference/mcp-api.md` with `bun run --cwd packages/server build:docs`. The em/en dash ban reaches those strings.
- **A style rule itself** - it lives in `packages/shared/src/prompt-style.ts` and is rendered into prompts at `{{prompt_style_rules}}`. Change the module, not a copy of the list.
- Every commit carries `Docs-Checked:` and `Prompts-Checked:`; one touching `packages/shared/src/` or `packages/web/src/` also carries `Translations-Checked:`.

Tests to run: `template-resolver`, `agent-prompt`, `captain-required-duties`, `qa-ci-merge-gate`, `marketplace`, `resolve-partials`, `default-skills`, `prompt-style`.

## Authoring a marketplace team, and the default skills

A marketplace team is prompt bodies in `agents/<team>/*.md` plus a `team.json` roster. How it
is discovered, ranked and provisioned at runtime is `architecture.md` § 4 (*Team marketplace*).
What binds you as the author:

## Marketplace teams
- **Team marketplace** (`marketplace/`, `agents/<team>/team.json`). Prompt bodies stay in `agents/<team>/*.md`; roster and metadata (name, description, summary, `keywords`, per-role slug/reports_to/effort/budgets/role_description/summary/team_context, `changelog`) live in a hand-authored `team.json`. A marketplace team ships only roster + prompts — no bundled skills, MCP servers or MPP config.
  - **`keywords` is the discovery vocabulary** — the words someone would type when they want this team. The New Project picker ranks against them above the team's own name, so make a team findable for a new phrasing by adding the phrasing, never by teaching the matcher about that team. Author readable words and phrases, not stems (`extractTerms`/`stemTerm` in `@hezo/shared` stem both sides); be generous with variants the stemmer won't fold ("code" *and* "coding"). Keywords are excluded from the content hash, so retuning them does not bump `version`.
  - `bun run --cwd packages/server build:marketplace` regenerates the committed JSONs — run it after editing any `agents/<team>/` prompt or `team.json`, **or any `agents/_partials/` file a team role resolves** (`bun run dev` does it automatically). It auto-increments `version` on a content-hash diff (excluding version/changelog/keywords); add a `changelog` entry per bump. **Commit the regenerated `marketplace/teams/*.json` + `index.json`** — production fetches them from GitHub raw, and `marketplace-build.test.ts` fails on a stale or missing file. It is deliberately outside `bun run build`, so a local build passes with the JSONs stale and only CI catches it.
  - `build:teams` bundles the committed JSONs into the gitignored `teams-bundle.json`, the offline fallback only. At runtime `services/marketplace.ts` prefers the repo folder in dev (`HEZO_MARKETPLACE_DIR`), then GitHub raw (`main`, then `master`), then the bundle.
  - Only the **Blank** template is seeded into the DB. Marketplace teams are never persisted as `team_templates`/`agent_types` rows — they are provisioned directly with `agent_type_id` null. Launch from one via `POST /api/projects {marketplace_slug}`; add to an existing project via `POST /api/projects/:projectId/marketplace-team`.
## Default skills
- `skills/<slug>.md` — the default global skills (flat dir, filename = slug; frontmatter `name`/`description`/optional `source_url`), bundled by `build:skills` into `skills-bundle.json`. A fresh instance auto-installs the catalog on first boot (`installDefaultSkillsIfFreshInstance`, before `seedDefaultTeam`, gated on HQ not existing); an upgrading instance is **not** auto-seeded — the operator installs missing ones from the global Skills page (`GET /api/skills/defaults`, `POST /api/skills/defaults/install`). A per-slug `system_meta` marker (`default_skill_shipped_hash:<slug>`) prevents re-offering a deleted default or clobbering a user-owned same-slug skill. Keep `skills/ATTRIBUTION.md` accurate (it's excluded from the bundle). Content rules: domain-neutral where the category allows, single self-contained document, short `description`, "task" never "ticket". `default-skills.test.ts` enforces the mechanical half; domain-neutrality is on you.
