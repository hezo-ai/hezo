# Agent Guidelines

**This file carries rules, not rationale, in as few words as leave them unambiguous.** No incident narratives, no defence of a rejected alternative, no example that only re-illustrates the rule above it. Cut every hedge, restatement and connective carrying no constraint.

**Name nothing you do not have to.** A file, function or constant earns a mention only when the rule cannot be obeyed without it - you must type it or grep for it to comply. A name that merely shows the rule is real, or points at the code implementing it, is rationale in a code font: delete it and check the rule still stands. Say a rule **once**, in the one place that covers its audience.

**Where a piece of writing goes** - decided by who needs it and when, not by what it is about:

| Writing | Home |
|---|---|
| A rule that binds anyone, or that someone could break without knowing they were in that territory | **this file** |
| The how-to for one kind of work - authoring an adapter, writing a migration | a `.dev/` guide, summarized here as its trip-wires plus a link |
| What the system *does* - data model, run pipeline, mechanisms | `.dev/architecture.md` |
| Anything a Hezo user or operator reads | `docs/` |

**A new specialized area is born as a `.dev/` guide, not as a new section here.** This file keeps only the rules that bind someone who does not yet know they are in that territory. Link a new guide from its section and add it to the map below; **Mirrored surfaces** already carries the row that covers guides added, renamed or removed.

**This file has a byte budget, enforced by `agents-md-budget.test.ts`.** When it fails, cut an entry down or move detail to a guide. Raising the number is a deliberate call to argue for in the commit, not a way to make the test pass.

## The `.dev/` map

The rules are here; the detail is there. Prefer reading the guide over rediscovering it.

| Doing this | Guide |
|---|---|
| Anything - what the system does and why | `architecture.md` |
| Writing or changing a test | `writing-tests.md` |
| Running the suite, reading CI, chasing one failure | `ci-and-commands.md` |
| Writing a migration | `writing-migrations.md` |
| Writing agent-facing prose, or authoring a marketplace team | `writing-agent-prompts.md` |
| Translating a string | `writing-translations.md` |
| Changing how a run is judged, delivered or priced | `agent-run-hooks.md` |
| Adding a container backend | `adding-a-container-backend.md` |
| Adding a chat channel | `adding-a-chat-channel.md` |
| Working around the Bun runtime | `bun-issues.md` |
| Looking up where a helper lives | `seam-registry.md` |
| Checking what else a change must touch | `mirrored-surfaces.md` |

Plus point-in-time decision notes and measurements, not rules: `hosted-architecture.md`, `microvm-assessment.md`, `target-audiences.md`, `container-backend-cost-comparison.md`, `mcp-cli-efficiency.md`, `hezo-cloud-requirements.md`.

## Commands

`bun run test` (add `--skip-browser` to drop Playwright, `--pattern` to narrow), `build`, `check`, `check:fix`, `typecheck`, `dev`, `release`. Bundle steps live in the server package and are invoked from there.

- **CI is the canonical check, not a local full run.** A dev box runs the suites serially against one database and fails some for reasons unrelated to your change. Iterate on a subset, keep `typecheck` in the loop, and let CI answer.
- **A run needing a live account or a paid key never runs in CI, and bills real money when you run it.** Supply only the credentials you mean to spend.
- **A required check names a rollup, never a bare matrix job** - a sharded job's name is not stable, so requiring it silently stops gating when the shard count changes.
- **No required check may need a write-scoped token**, or every fork PR fails on a permission it cannot be granted.
- **A suite needing the agent image runs in the container tier**, not on the general shards, which do not build it.

Flags, CI topology, running one file, diagnosing a failure: `.dev/ci-and-commands.md`.

## Layout

- `agents/<template>/*.md` - the single source of truth for agent system prompts. Marketplace teams compile from these plus a roster file; regenerate and commit the generated JSON in the same change.
- `skills/<slug>.md` - the default global skills. Domain-neutral, self-contained, short description.
- `.dev/` - internal engineering docs, and the home for the rationale this file omits.
- `docs/` - user-facing documentation. Some of it is generated; never hand-edit a generated page.

**Where guidance goes - pick by reach.** State a rule once, in the highest-reaching surface that covers its audience:

- Every agent, including future hires, on every run → the shared instructions.
- A subset of seeded roles → a shared partial.
- One role → that role's own prose.

A role doc never restates the shared instructions, and a responsibilities list never restates the workflow below it.

**Agent-facing prose is written to one register** - `.dev/writing-agent-prompts.md`. Trip-wires: one rule per bullet, short sentences, imperative and second person, the bold lead reads alone, no rationale unless the rule cannot be applied without it. **No Hezo symbol, path or precedent in anything that ships into someone else's repository.**

**The agent-facing surfaces are generated - update the generator and its test, never a static file.**

**A REST route and its tool twin must be named in parallel**, wherever both expose the same resource and action. The resource noun is mandatory and matches on both sides. Rename both in the same change; only internal identifiers a route reads from may keep historical names.

## Mirrored surfaces

**A fact represented in more than one place changes in all of them, in one commit - every code change ships with this pass, not a follow-up.**

The rows below are an **excerpt**. The full table is `.dev/mirrored-surfaces.md`; run your change against that, not against this. The last column is the one to read - where it says *nothing*, no test will catch you.

| Change | What mirrors it | Enforced by |
|---|---|---|
| A tool or route (params, response shape, auth) | the CLI and API docs, the generated reference, the skill file | drift tests |
| A route name | its tool twin, and the reverse | **nothing - on you** |
| A user-facing string | the eleven non-English catalogs | the catalog test |
| Prose in the shared instructions or a role doc | the assertions quoting it - reword the string, never delete the assertion | the suite, loudly |
| A docs page, or a link inside one | the embedded bundle; the target it names | bundle + link tests |
| Architecture (data model, run pipeline, auth, build) | `.dev/architecture.md` | the `Docs-Checked:` trailer |
| A config mechanism or data location an instance carries across a restart | a check that fails loudly on the old form, plus every deployment artifact still writing it | the `Upgrade-Checked:` trailer |
| A seam added or moved | `.dev/seam-registry.md`, and the excerpt below if it is one of the common ones | **nothing - on you** |
| A `.dev/` guide added, renamed or removed | the map above, and its section link | **nothing - on you** |
| **Removing** a feature | every stale reference repo-wide - grep for it | **nothing - on you** |
| User-visible behaviour, a feature, the setup flow | the relevant `docs/` page | **nothing - on you** |

**Verify, don't assume.** Generated surfaces have drift tests; prose has one guard, checking punctuation. Nothing checks whether prose is *true* - re-read the pages describing what you changed.

## Commit gates

Two hooks run on every commit: one lints, typechecks and builds; the other checks the message. **Never bypass either with `--no-verify`.**

**Four trailers record a pass no test can make.** Each is demanded when the commit stages a bearing path, and rejected if missing or under ten characters. Merge, revert, fixup, docs-only and test-only commits are exempt. A new bearing path joins that hook's pattern list in the same change.

| Trailer | Demanded when you stage | The pass it records |
|---|---|---|
| `Docs-Checked:` | source, migrations, prompts, skills, containers, deployment, scripts | you re-read `docs/` **and** `.dev/` for what you changed |
| `Prompts-Checked:` | agent-facing prose | the register in `.dev/writing-agent-prompts.md`, plus the check that no rule is now stated twice |
| `Upgrade-Checked:` | config, schema, migrations, startup, the updater, deployment | what an instance on the previous release does when it restarts onto this one |
| `Translations-Checked:` | web or shared source | every new or reworded string reached all twelve catalogs |

**The trailer must be true.** A good value names what you did (`updated the CLI reference for the new flag`) or why nothing applied (`internal refactor, no documented surface changed`).

Two more commit-time guards need no trailer. A broken link in a staged docs page fails the commit - fix the link, never bypass. A prompt-style **error** fails the commit and a **warning** only prints; demote a noisy rule rather than adding an exemption.

## Project / team model (1:1)

A **project** is the primary unit and owns exactly one **team**, its agent roster. Reach a team through its project, and address all project work by project slug. One internal project holds the two cross-project singletons - the **CEO**, who does all coordination and intake, and the **Coach**, who reviews completed tasks everywhere. Project rosters are a Captain plus worker roles and never include either.

**Cross-team execution:** a run is scoped to the **task's** project team - credentials, tooling, repository, container - while the agent's system prompt loads from its **home** team.

## Production upgrades

Real instances upgrade in place: same data directory, same config, same service definition, new binary. **A change to how Hezo is configured, where it keeps its data, or how it starts is a change to those instances, not just to this repo.** No test can see it - every suite builds a fresh instance from the code under test, so a self-consistent change passes green while breaking every instance that upgrades onto it.

- **A mechanism you remove or rename must fail loudly on its old form, never fall back to a default.** An instance that silently reverts to a built-in default comes up healthy and empty, which reads as a fresh install rather than a fault. Detect the old form and refuse to start, naming what was ignored and what replaces it.
- **Ship the migration, do not document it.** Where a deployment artifact this repo owns still writes the old form, the change that breaks it also translates it, in the same commit.
- **The in-app updater replaces the binary and nothing else.** It never edits a unit file, a config file or an argv. A change needing any of those changed cannot assume the operator did it.
- **A breaking-change note is not a migration.** It reaches whoever reads the changelog; it does nothing for the instance that auto-updated overnight.

## Database migrations

Migrations are real, tracked, append-only and data-preserving; real instances hold real user data, so one that drops or corrupts it is a production incident. **How to author one, and its data-preservation test: `.dev/writing-migrations.md`.** What binds before you get there:

- **Never edit a shipped migration.** Each is checksummed and applied once, so an edit is silently skipped on every existing instance - including your own.
- **Every new migration preserves existing data and ships a test proving it** - that pre-existing rows survived *and* that the change took effect. Not "the migration ran".
- **A schema change starts by checking for an unshipped migration to extend**, not by creating a file. One this branch added has been applied nowhere and is ordinary unmerged code.
- **Every cron or per-request query ships with its index**, in the same migration.

## Testing

All changes ship with tests exercising functionality, not "code runs without throwing". Prefer integration over heavily-mocked unit tests. **Tiers, harnesses and the traps in each: `.dev/writing-tests.md`.**

- **Default to the cheapest tier that can actually observe the thing.** Reach for a real browser only when the assertion needs real layout, a real viewport, native input events, a windowed list, a real socket, or the pre-auth gate; a headless DOM answers everything else. Every browser spec names at the top which of those keeps it there.
- **Runtime-sensitive code gets a test on the production runtime**, which is not the one the main runner uses - otherwise a wrong assumption passes while production breaks.
- **Every test isolates its own state and tears it down.** No shared singleton, no hardcoded port, no mutable state between files. **Start every test double from the complete stub**, never a hand-rolled partial.
- **A green run has a quiet log.** An error or warning line that is not the test asserting on an error path is a defect in the source. Track fire-and-forget work rather than letting it race teardown, and return the honest status code instead of a 500 the test then expects.
- **Scope every matcher to the test's own IDs** - a bare pattern matches background agent traffic. **Never raise a timeout to mask a race**; it is almost always a missing scope or a missing await.
- **Await a side effect the response or the next refetch must reflect.** Fire-and-forget is for work decoupled from the request. Wrap the awaited call so a failed side effect cannot fail the request.

## Code design

Write the second occurrence as shared code, not a copy.

- **Two call sites means extract** - one home, both places call it.
- **Pick the home by reach.** Server and web, or pure logic → the shared package. Several modules on one side → that side's shared directory. One consumer → keep it local until there is a second.
- **Validation lives once and runs twice.** A rule the client checks for feedback and the server enforces for real is one function, called from both.
- **Table over branch.** Behaviour varying by enum is a record read from, not a repeated switch: an unhandled value becomes a compile error and a new case becomes one row.
- **An entity's own quirks live in that entity's adapter, never in generic code.** A shared helper or pipeline branch that names one provider, runtime or backend is the defect - move the knowledge to the entity and have the generic path read it through the table.
- **Extend the existing seam before adding a parallel one.** If it genuinely does not fit, widen it rather than routing around it.
- **Preserve public signatures when changing internals** - keep the exported shape and delegate inward.
- **Generate what would otherwise be hand-synced**, and guard the remainder with a drift test.
- **Follow the idiom already in the file.** Novel structure needs a reason beyond preference.

**Don't over-rotate.** Extract on the second *real* occurrence, not the first imagined one.

### Seams

Before writing a helper, check whether it has a home. **Extend the seam; never add a parallel one**, and record a new one in `.dev/seam-registry.md` rather than naming its home inline. That is the full lookup; these are the seams most often reinvented:

| Need | Home |
|---|---|
| Guidance reaching every agent, now and future | `SHARED_INSTRUCTIONS` (`services/template-resolver.ts`) |
| Validating an authored prompt | `checkPromptStyle` (`@hezo/shared`) |
| A container backend | `ContainerEngine`, always via `SandboxBackendHolder.engine` |
| Fire-and-forget work | `trackBackground()` (`lib/background.ts`) |
| Paging, for a list or for large content | `mcp/paging.ts` |
| Shared enums, constants, validation run on both sides | `@hezo/shared` |
| A resolved operator setting | `runtimeConfig()` - never a bare `process.env` read |
| Serialising async work per key | `lib/keyed-lock.ts` - never a second mutex |
| An optimistic mutation | `useOptimisticMutation` |
| A primitive more than one app draws with | `@hezo/ui` - never resolve copy or read a raw `var(--token)` inside it |
| A complete test double | `createStubDocker()` |
| A test context | `createTestContext()` (server), `renderApp()` + `seed*()` (web) |
| A runtime's or provider's own quirk | that entity's adapter or table row |

## One mechanism, no silent fallbacks

When a design names a mechanism, that mechanism is **the** way it is done, on every backend and in every environment. None of the following ship unless the user explicitly asked:

- **No fallback path.** If the designated mechanism fails, **fail** - loudly, with an error naming what broke and what to check.
- **No rollout gate that leaves the new mechanism off.** Either it is ready and it is the only path, or it is not landed.
- **No capability branch above a seam.** A backend that cannot do what the interface requires is unsupported, not a second code path.
- **No "degrades to" behaviour invented at the call site** - no silent alternative, no retry landing somewhere else.

**When the designated mechanism genuinely cannot work somewhere, ask - do not decide it yourself.** State the constraint and the trade-off; the answer is often "then it is unsupported there". A deliberate exception is fine once that call has been made, and is written down as an exception.

## Translations

Twelve hand-authored catalogs. English is the source of truth; the other eleven are written against it and reviewed like any other code. **Mechanics and the per-language register: `.dev/writing-translations.md`.**

- **A user-facing string is not changed until it is changed in all twelve languages.** New, reworded, renamed or deleted - all twelve, same commit. Nothing flags a changed English source with stale translations underneath, and a new hardcoded literal is a missing key, not a shortcut.
- **A sentence containing a link or other node still goes through the catalog whole.** Never split a sentence into a key per fragment - that hard-codes English word order into all twelve languages.
- **"task", never "ticket" - in every language.** The guard only catches the English-shaped mistake. The dash ban applies to every language, and placeholders are copied verbatim.
- **One term per concept per language** - check the catalog before inventing a second word. Watch for repetition the English does not have, and recast rather than accept it. Product, role and team names and command text are never translated.
- **Register is a per-language decision, already made. Do not "fix" one language to match another.**
- **Quieting the identical-to-English check with an allowlist entry is the mistake it exists to prevent**, and an unreferenced key almost always means the component still renders the English word inline.

The guard cannot tell you whether a translation is *right*, or notice English copy that never became a key. That judgement is the pass this section asks for.

## Type safety

No `any` in source. Use specific types, `unknown`, records or generics. If a library lacks types, install them - never fall back to `any` or a bare declaration. `any` is acceptable only in tests handling unpredictable JSON, and in generated files nobody hand-edits.

## Design for scale, reuse and contention

The reference workload is **~10 concurrent agent runs on an instance holding 1GB+ of data**, in one process that is simultaneously the API, the tool endpoint, the egress proxy, the container control plane and - by default - the database.

- **Bound list endpoints in row count *and* row width.** Never return an unbounded column from a list route; send a size hint and serve the full value from the single-item read.
- **Every read returning a list, or content without a hard size cap, must page - and say so in its own response.** Lists take a limit and an opaque cursor; large content takes an offset and a byte budget; a batch pages by item index, always emitting at least one item so the cursor cannot stall. Keyset, never offset. **A hard limit with no cursor is the specific bug this prevents** - it drops rows silently with no way to reach them.
- **A list carries the structural fields callers reason about, not just the display ones.** A field the web UI gets and agents do not is a gap, not a scoping decision. Never suggest a remedy the caller cannot use.
- **Budget the round trips a request costs**, and load progressively - cheap structure first, heavy content on demand. A request whose cost grows with the rows it renders is a defect.
- **Filter, limit and aggregate in the query, and index what the query actually asks for.** A wrapped column or a JSON expression uses no index; filter-then-sort-then-limit wants a composite index in that order.
- **Never write a row that has not changed** - the embedded database does not vacuum, so a no-op update leaks storage.
- **Share resources; do not multiply them per unit of work**, and find out why something was scoped narrowly before you widen it.
- **A new mutex is a throughput ceiling.** Say in a comment what it protects and why a narrower scope is insufficient; never hold one across IO.
- **Stream; do not copy.** Data that can exceed a few MB is streamed end to end - never collected, joined or buffered before being sent. **Coalesce on the wire and respect backpressure**: an ignored send result is unbounded server-side buffering.
- **Every recurring job is bounded, observable, and paced to what it watches.** **A cache needs an invalidation story and a bound**, stated where you declare it.
- **Deleting the user's data is the operator's decision, never a default.** A table that only grows is a query-design problem. Only internal bookkeeping with no user-facing surface may be swept automatically, and the comment must say why it qualifies.
- **Measure the claim.** A performance change states what it improved and how that was observed.

## Build artifacts

Never commit compiled output alongside source. Delete generated files appearing in a source tree.

## Conventions

Use the shared CLI argument parser, never hand-parsed argv. Use the shared constants and enums rather than raw status or type strings, adding new values there first. Use `bunx`, not `npx`, in this repo's scripts, CI and docs - the rule stops at the repo boundary, since inside an agent container `npx` is correct.

### Bun runtime constraints

Bun is the production runtime and diverges from Node in ways that fail silently rather than throwing. **What we work around, what we are exposed to, and what was checked and cleared: `.dev/bun-issues.md`.**

- **The shipped runtime is the CI pin, not your local Bun.** A fix in a release above the pin is not a fix we have, and moving the pin is a production-runtime change.
- **A workaround carries a comment saying what was measured**, and survives until its upstream fix is in the pinned release. Never delete one as redundant without checking.
- **A resolved fetch is no proof of a complete body** - a mid-transfer stream error resolves with truncated data.

### Container backends
Every backend sits behind one seam. **Authoring or changing an adapter: `.dev/adding-a-container-backend.md`.** What binds every caller:

- **Nothing above the seam may learn which backend is in use** - no provider name in a conditional, no provider-shaped field on a shared type, no capability flag gating a method. Ask what *kind* of backend it is, never which one. A backend that cannot do what the interface requires is unsupported, not a second code path.
- **Take the holder's engine, never a concrete engine.** The backend is switchable at runtime, so a captured reference keeps driving the one the operator just left, and a type check against the holder silently stops running rather than failing.
- **Container management is backend-agnostic; only its transport is adapter-specific.** Code that cannot be written without knowing the backend means the seam is missing a method.

### Chat channel adapters
External chat avenues sit behind a channel adapter plus registry. **Adding one: `.dev/adding-a-chat-channel.md`.**

- **The core is channel-agnostic and stays that way** - resolve a channel through the registry, never by branching on a platform name. If a new channel forces a change there, close the gap in the abstraction instead.
- **One home surface per thread, and replies go where the turn was asked.** No adapter mirrors threads onto another channel. Channel-specific settings live in the adapter's own metadata, never a per-channel column; tokens go in the vault.

### User-facing docs terminology

These bind user-facing prose, not code identifiers, columns, route paths or internal comments.

- **Say "task", never "ticket". Say "global", never "instance-wide".**
- **Never use an em dash or an en dash. Use a hyphen.** Put a plain hyphen where an em dash would go; recast a paired parenthetical as parentheses or commas. This reaches generated pages through their sources - a tool description or schema note that carries one puts it in the docs. Internal-only text is exempt: code comments, `.dev/`, and this file.
- **The README carries no competitor-comparison section, ever**, under any heading. Describe what Hezo does on its own terms.

### Web frontend mutations
Three strategies, picked by shape. Default to optimistic with rollback, unless it is a create or a field where the server runs validation the UI should not preempt (**response-driven**), or validation-heavy or long-running work (**invalidate and refetch**).

**Security-sensitive mutations must never be optimistic** - a credential must not appear fulfilled until the server says it is.

Errors toast automatically on rollback; successes do not, because the UI change is the confirmation. The one carve-out is a result landing on a different page, which toasts with a link.

## Slugs vs UUIDs

Browser URLs use slugs; internal identifiers use UUIDs. Query keys and route params use the **route-param slug**, not a resolved UUID, so socket-driven invalidation matches. Inside a route, pass the route-param value to any child or hook whose key includes it - not the id from a resolved query. Rooms and server broadcasts use UUIDs. Mixing the two silently breaks realtime updates.

## UX

**All UI must be mobile-first and responsive.** Build the mobile layout first, then enhance upward - never the reverse. Desktop-only or fixed-width components are not acceptable. Mobile is single-column with a drawer and stacked fields; tablet brings back the rail and two-column grids; desktop adds the full sidebar and all table columns. Every UI change must work at all three, and every browser test for one must verify the mobile layout.

## Database transactions

Wrap any multi-write sequence that must succeed or fail together in a transaction. Prefer transactions over row locks for read-modify-write flows.

## Security

Never expose raw secrets, private keys or signing keys via endpoints or logs. Use asymmetric crypto for cross-service verification, encrypt sensitive data at rest, and compare every hash, token and signature in constant time - never with an equality operator.

### Red line: no plaintext confidential data in an agent run

**A hard architectural invariant.** An agent run - container env, arguments, config files, mounted files, logs, anything the agent process can read - must never contain a confidential value in plaintext. Every secret an agent touches is referenced only by a placeholder; the real value lives encrypted and is substituted **at the egress proxy**, at request time, scoped to the hosts it may fire for.

- **Assume the proxy catches everything.** A call bypassing it carries the unsubstituted placeholder and fails upstream - a usability failure, never a leak. "Fixing" that by materializing the real value into the run is a red-line violation, not a fix.
- **Sole exception - the run CLI's own model-provider credential**, injected in plaintext and sent direct, that endpoint being exempt from interception. It never licenses materializing any other secret.
- **Connectors are not exempt.** The descriptor loader resolves a secret's **name** and never decrypts its value.
- **Server-side code that resolves a credential must not take its destination, or any part of the value, from an agent.** Trace every field the destination is derived from back to who can write it; an agent-writable path that could move a credentialed row's destination must reject the write atomically, not merely be trusted not to. Return nothing derived from the value - no prefix, length, hash or masked form. Answer the diagnostic question instead, and scrub the value out of anything relayed from upstream.

### Never encourage storing the master key on a system

The master key is kept **in memory only, never written to disk** - the invariant that makes encryption at rest meaningful. **Never encourage a user to store it anywhere on a system**: not an env file, a service definition, a config file, a shell profile, a same-host secrets file, or a code comment. This holds on every surface an agent produces. A new process starts locked by default; a supervised in-app update hands the key to the new process in memory. A reboot, crash, or direct service restart stays locked unless the operator deliberately supplies the one-shot `--master-key` or `HEZO_MASTER_KEY` input, then the browser gate remains the interactive unlock path. The env var may be documented as the mechanism for a **single, non-interactive startup**, never as a place to persist the key.

### Credentials

Agents reference secrets by placeholder in any header or URL they emit, and the egress proxy substitutes at request time. Full lifecycle: `.dev/architecture.md` § *Credentials, egress & secrets*.

- **Put the placeholder in the container env, never the real value.** The stored secret constrains which upstream hosts substitution may fire for.
- **A credential that rides an outbound HTTP header must declare its allowed hosts**; the request is rejected otherwise.
- **Agents request the narrowest scope and shortest expiry**, and prefer a registered connector where one covers the provider. A raw secret reaches a run only by a human pasting it in response to an explicit request.

Secret values are never logged; substitution failures surface to the agent as explicit HTTP errors.

### Route authorization

Every route enforces authorization - never trust URL parameters alone.

- **Resolve the project to its backing team and verify access per request.** An agent token carries its team and must match.
- **Nested resources verify they belong to the parent** before any read or write. Global endpoints still verify team access.
- **Socket subscriptions verify team membership matches the room.**
- **Tool handlers enforce the same authorization as their route equivalents.**
- **API keys authenticate the tool surface only** - rejected on the REST and socket surfaces. An approved key is instance-scoped and admin-equivalent, so key management stays human-superuser-only: a key can never mint or approve keys.

## AI runtime hooks

Every task run ends through a completeness judge, a deterministic handoff-delivery net, and two structural signals. **Per-runtime wiring, prompt delivery and cost recovery: `.dev/agent-run-hooks.md`.** What binds before you get there:

- **The judge is for task runs only. Do not add one to a new non-task path.** Every rule it carries is about abandoning task work, and it reads only the final message; a chat turn has no task and its final message is already delivered. It costs a round trip per turn and, on a block, a whole turn spent on a task that does not exist.
- **Not every runtime can block and continue.** Where one cannot, the hook fails open by design - never paper over that with a second mechanism.
- **Strengthen this area with a structural signal, never a phrase.** Prefer reporting what the system did, or asking a question its own state answers, over matching text: every text-classifying check needs new vocabulary for each new phrasing, and a structural one needs none. A phrase that is genuinely needed joins the one shared vocabulary rather than becoming a new branch.
- **Judge behaviour reads the resolved runtime, never the provider** - a runtime is reachable by any credential configured onto it. **A newly selected judge model needs a pricing row**, or every run on it prices to $0.

## Cost: always priced from the table
Per-run cost is computed **always** from the pricing table, using the token counts each runtime reports. **A runtime's own dollar figure is ignored in every parser** - it is a client-side estimate from the CLI's built-in rate card, which for a third-party endpoint belongs to the wrong provider entirely. The CLIs' only job in cost accounting is accurate token counts. An unknown model prices to $0 - fail-low, never fail-high.

**Where usage is recovered from a file rather than stdout, scrub the file after parsing** - it can carry the provider credential in plaintext. Parsing such a log has three traps, each of which otherwise prices runs silently wrong; they are in `.dev/agent-run-hooks.md`, and you will not guess them.

## Container toolset
The agent image pre-bakes the common toolchain, and anything else installs cleanly at runtime through the per-run egress proxy with our CA already trusted. **`wget` is deliberately absent - use `curl`.** **If you add a tool, add it to the toolset paragraph in the shared instructions too**, or agents will not know it exists.

**Every agent CLI is pinned, and a new one arrives pinned**: a version argument, an install referencing it, and a version check that fails the build. An unpinned CLI changes a run's behaviour with no commit and no signal. **Pinning is not upgrading** - pin at whatever the current release resolves to, and treat a bump as its own change. A binary artifact is pinned once per architecture, since only the release build covers both.
