# Design-Patterns Audit & Roadmap

> A prioritized look at where established design patterns can make the code more
> **maintainable**, **testable**, and **easier to scale**. This is a roadmap, not a
> changelog — nothing here has been implemented yet. Every recommendation extends a
> pattern **Hezo already uses elsewhere** (cross-linked in §1) rather than importing a
> new abstraction.

**Validated against `main` @ `33f2a1f`.** Line anchors are clickable; re-check them
before acting (line numbers drift).

## Guiding principle

Hezo is already pattern-mature. The recurring smell is not "missing architecture" — it's
**per-type branching that fragmented across files** as runtimes/providers/approval-types
were added. The fix each time is the same: lift the branch into a **registry keyed by the
enum**, so adding a case is one declarative entry and TypeScript enforces completeness.

Keep the house style: **functions + `Record<Enum, …>` lookup tables, not class
hierarchies.** Two of the findings below are mostly *mechanical relocation* behind a
registry, not logic rewrites.

---

## 1. North-star idioms (already done right — reuse these)

These are the in-repo exemplars every recommendation points back to. "Make X look like Y."

| Pattern | Canonical exemplar in the repo |
|---|---|
| **Registry** (TS-enforced completeness) | `MCP_ADAPTERS: Record<AgentRuntime, RuntimeMcpAdapter>` — `services/mcp-injectors/index.ts:12`; the `RuntimeMcpAdapter` interface — `mcp-injectors/types.ts:87`; the `RUNTIME_*` maps + `PROVIDER_RUNTIME_ADAPTERS` — `shared/src/types/common.ts:575`+ |
| **Strategy dispatch** | `RendererRegistry = { [K in CommentContentType]: … }` — `web/src/components/comment-renderers/index.tsx:42` |
| **Observer** (per-app Subject, not a singleton) | `DomainEventBus` — `server/src/events/bus.ts:20`; `registerAuditObserver` + `mapEventToAudit` — `events/audit-observer.ts:16,145` |
| **Dependency injection / test seam** | `RunnerDeps` interface — `services/agent-runner.ts:113`; `createStubDocker()` — `test/helpers/app.ts:44` |
| **Result discriminated union** | `ResolveApprovalResult` — `services/approval-resolve.ts:26` |

The whole audit is "spread the top-left cell (the registry) to the places that still
hand-roll a `switch`."

---

## 2. Finding 1 — Runtime strategy registry  ·  *Strategy + Registry*  ·  **HIGH / low–med risk**

**The headline.** Static per-runtime knobs are already centralized as lookup tables in
`common.ts` (`RUNTIME_COMMANDS:675`, `RUNTIME_AUTO_APPROVE_ARGS:686`,
`RUNTIME_STREAM_ARGS:713`, `RUNTIME_HEADLESS_PREFIX_ARGS:724` /
`RUNTIME_HEADLESS_SUFFIX_ARGS:736`, `RUNTIME_DISALLOWED_TOOLS_ARGS:700`). But the
*behavioral* per-runtime logic never made it into a table — it's scattered as independent
`switch` statements:

| Behavior | Location | Shape |
|---|---|---|
| Effort → CLI args/env/prompt | `services/effort.ts:88` (`applyEffortToRuntime`) | `switch(runtime)`, 3 arms |
| Stdout stream parsing | `services/agent-stream-parser.ts:31` (`createAgentStreamParser`) | `switch(runtime)`, ClaudeCode vs passthrough |
| Subscription blob validation | `services/subscription-auth.ts:86` (`validateSubscriptionBlob`) | `switch(provider)`, OpenAI/Google |
| Stop-hook judge script | `services/stop-hook-prompt.ts:162,190` (`buildCodexJudgeScript`/`buildGeminiJudgeScript` over `buildJudgeScript:116`) | per-runtime spec objects |
| MCP config emission | `services/mcp-injectors/{claude-code,codex,gemini}.ts` | already registry-dispatched; see Finding 1b |

**Cost today:** adding a 4th runtime means hunting across ~6 files and hoping none was
missed. The compiler won't tell you that `createAgentStreamParser` silently falls through
to passthrough for the new runtime, or that `applyEffortToRuntime`'s `switch` is now
non-exhaustive.

**Recommendation.** Introduce one `RUNTIME_STRATEGIES: Record<AgentRuntime,
RuntimeStrategy>` — the exact shape as `MCP_ADAPTERS` — co-locating the behavioral pieces:

```ts
// services/runtime-strategy.ts (new) — sketch
export interface RuntimeStrategy {
  applyEffort(effort: AgentEffort): EffortRuntimeApplication;   // from effort.ts
  createStreamParser(): AgentStreamParser;                       // from agent-stream-parser.ts
  buildJudgeScript(): string | null;                            // from stop-hook-prompt.ts
  readonly mcp: RuntimeMcpAdapter;                              // re-export the existing MCP_ADAPTERS entry
}

export const RUNTIME_STRATEGIES: Record<AgentRuntime, RuntimeStrategy> = {
  [AgentRuntime.ClaudeCode]: { /* … */ },
  [AgentRuntime.Codex]:      { /* … */ },
  [AgentRuntime.Gemini]:     { /* … */ },
};
```

Each call site becomes `RUNTIME_STRATEGIES[runtime].applyEffort(effort)` etc. The
`Record<AgentRuntime, …>` typing makes a missing runtime a **compile error** — the same
guarantee the doc-comment on `MCP_ADAPTERS:8-11` already advertises.

**Nuance — two keying axes, don't force-merge them.** Effort and stream parsing are
**runtime**-keyed; subscription validation is **provider**-keyed (OpenAI/Google → the
same Codex/Gemini runtimes, but DeepSeek/Z.ai share the ClaudeCode runtime with different
auth). Keep subscription validation in a `Record<AiProvider, …>` (or fold it into the
provider registry — Finding 3) and bridge with the existing `PROVIDER_TO_RUNTIME`
(`common.ts:652`). Forcing one table over both axes would re-introduce the special-casing
this is meant to remove.

**Why it's low-risk:** every moved function is already pure and unit-tested (`effort.ts`,
`agent-stream-parser.ts` have direct tests). This is relocation behind a registry, not a
behavior change — port the existing tests verbatim and add one "registry has an entry for
every `AgentRuntime`" exhaustiveness test.

### Finding 1b — MCP injector descriptor scaffold  ·  *Template Method (lightweight)*  ·  MED

The MCP injectors are the **good** case — already `MCP_ADAPTERS`-dispatched behind a clean
`RuntimeMcpAdapter` interface. The residual duplication is in the three `build()` bodies,
which each repeat the same scaffold (see `codex.ts:108-120` for the canonical shape):

1. iterate descriptors, dispatching `d.kind === 'http' ? renderHttp(d) : renderStdio(d)`,
2. collect bearer-token env entries from the HTTP descriptors,
3. assemble `{ cliArgs, envEntries, files: [config, judgeScript?] }`.

Only the **rendering** genuinely differs (TOML for Codex, JSON for Claude Code/Gemini) and
where the bearer token lives (`bearerTokenStorage: 'inline' | 'env-var'`, already declared
in `capabilities`). **Recommendation:** extract the iteration + bearer-collection scaffold
into a shared helper that takes per-runtime `renderHttp`/`renderStdio` callbacks; leave the
renderers in each adapter. Do **not** introduce an abstract base class — the existing
function-object adapters fit the codebase better. This is a *nice-to-have* dedup, not a
correctness fix; bundle it with Finding 1 only if touching the injectors anyway.

---

## 3. Finding 2 — Approval handler registry  ·  *Strategy / Command*  ·  **HIGH / low risk**

**Best stand-alone first refactor** — single file, contained blast radius.

`applyApprovalSideEffect` (`services/approval-side-effects.ts:58`) is a ~280-line
`switch(approval.type)` (the `switch` opens at `:71`):

| Case | Lines |
|---|---|
| `ApprovalType.Hire` | 72–178 |
| `ApprovalType.Strategy` | 179–205 |
| `ApprovalType.ProjectCreation` | 206–316 |
| `ApprovalType.SkillProposal` | 317–348 |

Each arm mixes payload parsing, DB writes, and `trackBackground(...)` fan-out, so testing
one approval type means standing up the whole function. Its sibling
`applyApprovalDeniedSideEffect` (`:40`) branches on the same enum and drifts independently.

**Recommendation.** A handler registry keyed by `ApprovalType`:

```ts
interface ApprovalHandler {
  apply(approval, ctx): Promise<void>;
  applyDenied?(approval, ctx): Promise<void>;
}
const APPROVAL_HANDLERS: Record<ApprovalType, ApprovalHandler> = { /* one per type */ };
```

Each handler becomes independently unit-testable; a new approval type is one entry the
compiler forces you to add (vs. a silently-missing `case`). This mirrors `mapEventToAudit`
(`audit-observer.ts:16`) and the comment-renderer registry exactly.

---

## 4. Finding 3 — Complete the provider adapter  ·  *Adapter + Registry*  ·  MED / low–med risk

`AI_PROVIDER_INFO` (`common.ts:756`) already centralizes per-provider verify endpoints and
display metadata — a half-built provider registry. But three provider quirks still live
*outside* it as inline special-cases:

- `parseProviderModels` (`common.ts:822`) — special-cases Google's `models[]` shape vs
  everyone else's `data[]`.
- `isChatModelId` (`common.ts:853`) — special-cases OpenAI's non-chat model filter.
- `validateSubscriptionBlob` (`subscription-auth.ts:86`) — `switch(provider)`.

**Recommendation.** Add `parseModels`, `filterChatModel`, and (optionally)
`validateSubscription` to the `AI_PROVIDER_INFO` entries so each provider's wire-format
quirks are declared in one place and a new provider is a single registry entry, not a
multi-file audit. Pairs naturally with Finding 1's provider-keyed axis.

---

## 5. Finding 4 — Web: hold the line, surgical wins only  ·  LOW–MED

The web layer already has the right templates: `useOptimisticMutation`
(`web/src/hooks/use-optimistic-mutation.ts:35`) and the `comment-renderers` registry
(`:42`). It's also under active churn (recent PRs #142–#144 reshuffled header/sidebar/nav),
so **avoid structural refactors here** — they'd collide with in-flight UI work.

Two genuinely surgical wins, no framework:

- **Mutation boilerplate** — the CRUD hooks repeat `onSuccess` + `invalidateQueries`
  scaffolding. A couple of thin helpers can absorb it. **Do not** build a
  "mutation-strategy factory" — the three documented strategies (optimistic /
  response-driven / invalidate, per `AGENTS.md`) are a *human* decision, not something to
  abstract behind a selector.
- **Error display consistency** — most forms surface errors via toast/inline; at least one
  path uses `alert()` for validation. Standardize on the existing toast + inline pattern.

---

## 6. Finding 5 — Widen `DomainEventBus` adoption (optional)  ·  *Observer*  ·  LOW

`DomainEventBus` (`events/bus.ts:20`) is clean but has effectively one consumer (audit).
Several side-effects today are implicit `trackBackground(...)` calls inside service
methods (e.g. inside the approval switch). **Optional future direction:** emit a few more
granular domain events (`approval.resolved`, `task.status_changed`) and move those
side-effects into explicit subscribers — making the cascade auditable and testable in
isolation. Flagged as *optional*; only worth it if the implicit fan-out becomes hard to
follow.

---

## 7. Scoped out (considered, deliberately deferred)

| Idea | Why not now |
|---|---|
| **API endpoint facade + codegen across 50+ hooks** | Low ROI, high churn; the current `api` client + per-hook calls are readable. Revisit only if endpoint drift becomes a real bug source. |
| **`runAgent` / `buildRunContext` Builder + Chain-of-Responsibility rewrite** (`agent-runner.ts`) | The functions are long, but the ordering (credential lock → ssh socket → egress proxy → context → exec → cleanup) is intentional and safety-critical. A builder chain risks subtle ordering/cleanup regressions. At most, extract cohesive **pure** helpers (env assembly, prompt templating) when already touching the code — no framework. |
| **Result-monad migration everywhere** | Discriminated-union results already exist where they pay off (`approval-resolve.ts:26`). A blanket migration is stylistic churn. |
| **Form custom-hook / compound-component overhaul** | Stylistic; low correctness value; collides with active web churn (Finding 4). |

---

## 8. Suggested sequencing

1. **Finding 2 (approval registry)** — smallest, single-file, highest-confidence; use it as
   the reference refactor that establishes the "switch → `Record<Enum, Handler>`" pattern.
2. **Finding 1 (runtime strategy registry)** — the strategic win for scaling to new
   runtimes/providers; do after Finding 2 so the registry idiom is already proven here.
3. **Finding 3 (provider adapter)** — folds in alongside Finding 1's provider axis.
4. **Finding 1b / Finding 4 / Finding 5** — opportunistic, only when adjacent code is open.

Each step is independently shippable with its own tests and leaves the tree green.
