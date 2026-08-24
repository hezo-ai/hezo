# Mirrored surfaces

The full table of facts represented in more than one place. `AGENTS.md` carries the rule -
a fact represented in more than one place changes in all of them, in one commit - plus an
excerpt of the rows an ordinary change trips. This is the checklist: **run it against the
whole table, not the excerpt.**

**Extend this table rather than restating the obligation in prose.** The last column is the
one to read: where it says *nothing*, no test will catch you.

| Change | What mirrors it | Enforced by |
|---|---|---|
| MCP tool / REST route (params, response shape, auth) | `docs/reference/cli.md`, `docs/mcp/hezo-mcp-server.md`, generated `docs/reference/mcp-api.md`, the `SKILL.md` generator, `llms.txt` | `mcp-reference.test.ts`, `llms-txt.test.ts` |
| A REST route name | its MCP-tool twin (same resource noun) | **nothing - on you** |
| A user-facing string | the 11 non-English catalogs | `i18n-catalog.test.ts` |
| A team prompt or `team.json` | committed `marketplace/teams/*.json` + `index.json` | `marketplace-build.test.ts` |
| Prose in `SHARED_INSTRUCTIONS` or a role doc | the ~324 `toContain` strings quoting it (`template-resolver{,-cov-fill}`, `qa-ci-merge-gate`, `mention-handoff-prompt`, `connector-recipes-skill`, `mcp-tools`, `description-tasks`, `agent-types`, `coach`) — reword the string, never delete the assertion | the suite, loudly |
| A prompt-style rule | `packages/shared/src/prompt-style.ts`, its `{{prompt_style_rules}}` render, the authoring tool descriptions, `.dev/writing-agent-prompts.md` | `mcp-reference.test.ts` for the tool docs, **nothing for the rest** |
| A new surface that accepts an authored prompt | its `checkPromptStyle` call | **nothing - on you** |
| A new server-wired wakeup path reachable from an agent run | `created_by_run_id` on the wakeup it creates | **nothing - on you** |
| A docs page (add / remove / frontmatter) | the embedded docs bundle | `docs-bundle.test.ts` |
| A link in a `docs/` page (another page, an anchor, a repo file, an external URL) | the target it names | `docs-links.test.ts` + the `check-docs-links.ts` hook |
| A new conformance suite | `conformance/index.ts` | `conformance-coverage.test.ts` |
| A new doc- or string-bearing path | `DOC_BEARING_PATTERNS` / `STRING_BEARING_PATTERNS` | its ack-hook test |
| Container backend behaviour | `SANDBOX_AGENT_ENVIRONMENTS`, that provider's `docs/containers/remote/` page, the Containers settings UI | compile error, **new backend only** |
| A pool-member state transition | its `container_uptime_entries` open or close - the ledger is written inside `pool-db.ts`, so a transition added elsewhere is billed nowhere | **nothing - on you** |
| A `ContainerEngine` method added or its contract changed | every adapter, the conformance suite, `.dev/adding-a-container-backend.md` | compile error for the method, **nothing for the contract** |
| Architecture (data model, run pipeline, providers, egress, SSH/git, OAuth, auth, build) | `.dev/architecture.md` | the `Docs-Checked:` trailer |
| A config mechanism, data location or startup path an existing instance carries across a restart | a check that fails loudly on the old form, plus every deployment artifact in `deploy/` still writing it | the `Upgrade-Checked:` trailer |
| A `.dev/` guide added, renamed or removed | the `.dev/` map table in `AGENTS.md`, the link from its section there, and this table | **nothing - on you** |
| A Bun workaround added or removed, or `BUN_VERSION` moved | its entry in `.dev/bun-issues.md` | **nothing - on you** |
| A rule `AGENTS.md` states | its guide in `.dev/`, if one covers that area - they must not disagree | **nothing - on you** |
| A new rule added to `AGENTS.md` | that file's byte budget - fitting it in usually means cutting something else down | `agents-md-budget.test.ts` |
| CLI flag / subcommand / config key / port / default (`src/cli.ts`, `src/config/`) | `docs/reference/cli.md`, `docs/deployment/configuration.md`, the CLI table in `packages/server/README.md`, any page showing the command | **nothing - on you** |
| A new operator setting | its `config/types.ts` field + `DEFAULT_CONFIG` default, its `config/schema.ts` entry, and its row in `docs/deployment/configuration.md` | a missing type field is a compile error; **an unvalidated or undocumented key is on you** |
| A sharded, renamed or newly-required CI job | its `*-complete` rollup, a shard-unique matrix artifact name, the `main` ruleset's required checks | **nothing - on you** |
| A tool added to the container image | the toolset paragraph in `SHARED_INSTRUCTIONS` | **nothing - on you** |
| A new AI provider (`AiProvider` + `PROVIDER_RUNTIME_ADAPTERS`) | `.dev/architecture.md`, the provider docs, `model_pricing` rows, and a decision on `claudeCodeProviderUsesCustomEndpoint` | **nothing** - an unpriced model silently records $0 |
| A provider gaining a second CLI (`alternateRuntimes`) | a `ProviderRuntimeBinding` for the new pairing, declared once as a constant if two providers share it | compile error for a missing binding, **nothing for a duplicated one** |
| User-visible behaviour, a feature, the setup/onboarding flow | the relevant `docs/` page(s) | **nothing - on you** |
| **Removing** a feature | every stale reference repo-wide (`docs/**`, `.dev/`, READMEs, comments) - grep for it | **nothing - on you** |

