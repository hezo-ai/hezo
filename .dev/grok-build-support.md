# Grok Build support — Design & Feasibility Assessment

Assessment of adding **xAI Grok Build** (the `grok` CLI, `grok-build` /
`grok-4.5`) back as a Hezo AI provider + runtime, written 2026-07. This is a
**decision reference and implementation plan**, not a commitment. The
runtime-capability claims below were verified empirically against **Grok Build
`0.2.93` (linux-x86_64)** installed and probed in a Hezo container on the date
above — not from the docs, which lag the CLI. External facts (CLI flags, stream
schema, model ids) will drift; re-run the probes in "How the facts were
verified" before acting.

**Verdict up front:** re-adding Grok is **feasible and low-risk**, and much
cheaper than the first attempt (PR #460, reverted in #481). Grok Build turns
out to be heavily **Claude-Code-compatible** — it reads `.claude/settings.json`,
mirrors Claude Code's permission modes / `--system-prompt` override / MCP
`config.toml` shape / `stream-json` event schema, and reports the **same
Anthropic-style token buckets** Hezo already prices from. So the new adapter and
stream parser are near-clones of the existing Claude Code ones, not the
from-scratch TOML/Codex hybrid #460 built. The one true limitation — Grok's
`Stop` hook is passive and cannot block-and-continue — means the completeness
judge is **omitted (fail-open), exactly like OpenCode**. That is an accepted,
precedented posture, not a blocker.

Recommended path: **native `grok` runtime on the `grok-build` model alias, judge
omitted.** The alternative (route `grok-4.5` through Codex's OpenAI-compatible
provider to keep the judge) trades away the model's native harness tuning and is
not recommended unless the completeness gate is non-negotiable.

## History — this is a re-add, not a new integration

- **PR #460** ("add xAI Grok Build as a runtime + provider") first shipped it,
  as a *standalone* runtime with a from-scratch TOML MCP adapter and a blocking
  `Stop`-hook completeness judge.
- **PR #481** ("switch Kimi to Claude Code, drop xAI/Grok, hide OpenRouter")
  retired it as part of a cost-accounting cleanup — Grok Build was a rough beta
  and its cost reporting was unreliable.
- Migration `007_add_xai_provider.sql` added the `x_ai` enum label;
  `010_retire_xai_provider_and_kimi_runtime.sql` revoked active `x_ai` configs
  and nulled task/agent pins. **The `x_ai` enum label still exists in the DB**
  (Postgres can't drop enum values), so re-adding reuses it rather than adding a
  new one.

Two things have changed since #481 that flip the calculus:

1. **Grok Build matured** from the beta of #460 into a real first-party coding
   agent (`0.2.93` at time of writing) with plugins, skills, subagents, hooks,
   MCP, plan mode, and a documented headless mode.
2. **The cost concern that drove #481 is moot.** Hezo now prices **exclusively
   from the `model_pricing` table** (`AGENTS.md` § "Cost: always priced from the
   table"); runtime-reported dollar figures are ignored across every parser. So
   Grok's cost reliability is irrelevant — all Hezo needs from the CLI is
   accurate token counts, which it emits (see below).

**Re-adding is *not* a revert of #481.** The #460 adapter was built on guesses
(TOML `[[hooks.Stop]]` command hooks, a blocking Stop judge) that the probes
below prove wrong. The new adapter should be rebuilt against the verified
reality.

## How the facts were verified

Installed and probed in a Hezo-equivalent container (linux-x86_64, behind the
egress proxy):

```sh
curl -fsSL https://x.ai/cli/install.sh | bash          # → ~/.grok/bin/grok, no npm
grok --version                                          # grok 0.2.93 (f00f96316d)
grok --help ; grok agent --help ; grok mcp add --help   # flag/format surface
grok mcp add --transport http hezo https://example.test/mcp \
     --header "Authorization: Bearer TESTTOKEN"          # → real config.toml
grok inspect --json                                     # config discovery (hooks/mcp/skills)
grok models                                             # auth-gated; default alias printed
XAI_API_KEY=xai-DUMMY grok -p "say hi" \
     --output-format streaming-json --max-turns 1 --always-approve   # envelope + egress host
strings ~/.grok/downloads/grok-linux-x86_64 | grep -E 'input_tokens|...'  # usage schema
```

Everything in the tables below is from these runs, except the exact model-id
string (auth-gated — see Residual unknown).

## What Grok Build is, mechanically

- **Binary:** single ~153 MB static executable. Installer
  `curl -fsSL https://x.ai/cli/install.sh | bash -s <version>` (version pinnable;
  channels `stable|alpha|enterprise`), installs to `~/.grok/bin/{grok,agent}`.
  **No npm dependency** (unlike the other four runtimes' CLIs).
- **Auth:** `XAI_API_KEY` (public API) or `grok login` OAuth (consumer/Teams
  relay). With `XAI_API_KEY` set, a headless run calls
  **`https://api.x.ai/v1/responses`** directly — the xAI **Responses API**. No
  OAuth needed for the API-key path.
- **Config:** `~/.grok/config.toml` (user) / `./.grok/config.toml` (project) /
  `--plugin-dir <dir>` (per-process, "always trusted — hooks and MCP servers
  activate without a prompt").
- **Claude-Code compatibility (the key finding):** `grok inspect --json` reports
  it reads `.claude/settings.json` and `/etc/claude-code/managed-settings.json`,
  honours `allowedTools`/`--system-prompt` equivalents, and discovered an
  existing `~/.claude/skills/` skill unprompted. Permission modes are the Claude
  Code set: `default, acceptEdits, auto, dontAsk, bypassPermissions, plan`.

## Runtime mapping to Hezo

| Hezo need | Grok Build mechanism | Notes |
|---|---|---|
| Headless launch | `grok -p "<prompt>"` **or `--prompt-file <path>`** | File input is cleaner than OpenCode's arg mode; can set `HEZO_PROMPT_MODE` accordingly. |
| Structured output for the parser | `--output-format streaming-json` | Typed `{"type":...}` events: `assistant`, `result` (`subtype`/`is_error`/`duration_ms`/`session_id`/`num_turns`), `error`. Same shape as Claude Code `stream-json`. |
| **Token/cost accounting** | `result` event carries `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | **Anthropic-style buckets — identical to what `agent-stream-parser.ts` already extracts for Claude Code.** Price from the table as always. |
| System prompt injection | `--system-prompt-override <prompt>` (+ `--rules`) | Hezo injects the agent's home-team system prompt. |
| Auto-approve tools (headless) | `--permission-mode bypassPermissions` (or `--always-approve`) | **Required** — without it, tool calls block on approval and a headless run hangs. |
| Turn cap | `--max-turns <N>` | Native. |
| Model selection | `-m <model>` | Default alias `grok-build`; exact `grok-4.5` id auth-gated (see Residual unknown). |
| MCP servers (Hezo's task tools) | `[mcp_servers.<name>]` in `config.toml`, `transport=http` (streamable HTTP), inline `[mcp_servers.<name>.headers]` `Authorization = "Bearer …"` | Verified by `grok mcp add`; structurally identical to Hezo's Claude Code MCP injection. `--plugin-dir` is an even cleaner always-trusted injection path. |
| Egress | Direct to `api.x.ai` (`NO_PROXY`), `XAI_API_KEY` env-injected | Sanctioned "model-provider credential" exception (like `ANTHROPIC_API_KEY`). Git/MCP placeholders still use the proxy. |
| Quiet automation | `[cli] auto_update = false` | Analogue of `CLAUDE_CODE_QUIET_ENV` / `GEMINI_RUNTIME_ENV`. |

### The generated `config.toml` (verbatim from `grok mcp add`)

```toml
[mcp_servers.hezo]
url = "https://example.test/mcp"
enabled = true

[mcp_servers.hezo.headers]
Authorization = "Bearer TESTTOKEN"
```

## The one real limitation — completeness gate

Grok Build's hooks are Claude-Code-shaped JSON (`~/.grok/hooks/*.json`, plus it
reads `.claude/settings.json`) with events `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `SessionEnd`,
`SubagentStop`, `PreCompact`, … **but only `PreToolUse` is a blocking event**
(exit 2 = deny). `Stop`/`SessionEnd` are **passive notifications** — they fire
*after* the agent has decided to stop and cannot force it to continue. There is
no `decision:"block"` / `stop_hook_active` equivalent.

Hezo's completeness judge requires **block-and-continue** at turn end (Claude
Code prompt `Stop`, Codex command `Stop`, Gemini `AfterAgent`). Grok can't
provide it. **Therefore the judge is omitted for the Grok runtime — fail-open,
identical to OpenCode** (`AGENTS.md` § "AI runtime hooks": OpenCode already runs
with the judge omitted for the same "can't block-and-continue" reason).

Native mitigations available if we want a softer floor (optional, not v1):

- `--max-turns <N>` — hard turn budget.
- `--check` — "append a self-verification loop to the prompt (headless only)".
- `--best-of-n <N>` — run the task N ways, pick the best (headless only).

## Implementation plan (recommended: native runtime, judge omitted)

**0. Spike already done** — CLI installed, formats confirmed. Remaining spike
item: one authenticated `grok models` + a real 1-turn `streaming-json` run to
lock the model-id string and capture the exact `result` event (needs a real
`XAI_API_KEY`).

**1. Shared core — `packages/shared/src/types/common.ts`**
- `AgentRuntime.Grok = 'grok'`; `AiProvider.XAi = 'x_ai'` (label already in DB).
- `PROVIDER_RUNTIME_ADAPTERS['x_ai']`: `runtime: Grok`,
  `credentialEnvByAuthMethod: { api_key: 'XAI_API_KEY' }`, static env
  `{ auto_update off }` as needed. API-key auth only (no subscription path).
- `PROVIDER_UPSTREAM_HOSTS['x_ai'] = ['api.x.ai']` for the NO_PROXY bypass;
  `PROVIDERS_BY_RUNTIME` / `PROVIDER_TO_RUNTIME` pick it up automatically.
- `RUNTIME_PROMPT_DELIVERY[Grok]` (arg or file — prefer `--prompt-file`);
  effort mapping in `effort.ts` (map to `--reasoning-effort`).

**2. MCP injector — new `packages/server/src/services/mcp-injectors/grok.ts`**
- Model on `claude-code.ts`: write Hezo's MCP descriptors as `[mcp_servers.*]`
  into `~/.grok/config.toml` (or a `--plugin-dir` bundle), inline bearer header,
  `[cli] auto_update=false`.
- **No judge script, no Stop hook.** Register in `index.ts`.
- Reuse `toml.ts` helpers (already present for Codex) if writing TOML directly.

**3. Runtime plumbing — `agent-runner.ts`, `runtime-home.ts`**
- Launch: `grok --prompt-file <file> --output-format streaming-json
  --permission-mode bypassPermissions -m grok-build --max-turns <n>
  --system-prompt-override <prompt>`.
- Egress: `api.x.ai` direct, `XAI_API_KEY` env-injected.
- Decide on `--disable-web-search`: Grok's built-in web-search/fetch tools route
  through xAI infra — an egress-surface decision (leave on for capability, or
  disable for a tighter allowlist).

**4. Stream parser — `agent-stream-parser.ts`**
- Reuse the Claude Code `stream-json` path; usage buckets are identical
  (`input_tokens`/`output_tokens`/`cache_creation_input_tokens`/
  `cache_read_input_tokens`). Cost from the table.
- Confirm `pricepertoken.com` carries the Grok model and that model-id
  normalization maps xAI's reported id to the catalog slug (unpriced ⇒ silent
  $0).

**5. Container image — `docker/Dockerfile.agent-base`**
- `RUN curl -fsSL https://x.ai/cli/install.sh | bash -s <pinned-version>` (routes
  through the egress proxy; Hezo CA already trusted). No npm.

**6. Web — `provider-logos.tsx`, add-provider dialog / picker**
- Re-add the xAI card, API-key-only.

**7. Migration + test**
- New `NNN_*.sql` — label already exists, so likely no DDL (a documented no-op or
  a comment migration). **Mandatory** `migrate-NNN-*.test.ts` data-preservation
  test per `AGENTS.md`. Note `010` revoked historical `x_ai` rows, so upgraded
  instances that once ran Grok re-add fresh.

**8. Stop-hook / judge registry**
- Grok stays **absent** from `CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER` and gets no
  command-script judge. Assert its absence in `stop-hook-judge-registry.test.ts`.

**9. Docs / drift (same PR)**
- `.dev/architecture.md` (runtime roster + the fail-open judge note and *why*),
  `docs/ai-models.md`, `docs/getting-started/first-run.md`,
  `docs/introduction.md`, `README.md`, `AGENTS.md` runtime/provider list.
- No MCP-tool/REST changes → `mcp-api.md` / `SKILL.md` / `llms.txt` untouched.

**10. Tests**
- `mcp-injectors.test.ts` (Grok writes the expected `config.toml`),
  `provider-runtime.test.ts`, `runtime-resolver.test.ts`,
  `stop-hook-judge-registry.test.ts`, agent-runner + stream-parser tests, the
  web provider test.

## Rejected alternative — route grok-4.5 through Codex

Codex can point at an OpenAI-compatible provider (`[model_providers.xai]`,
`base_url=https://api.x.ai/v1`, `wire_api="chat"`), which would **preserve the
Codex `Stop` command-hook judge**. Rejected as the default because it runs
`grok-4.5` inside OpenAI's agent harness rather than Grok Build's own — xAI ships
`grok-4.5` specifically to drive Grok Build, so this likely underperforms. Keep
it in the back pocket only if the completeness gate becomes non-negotiable.

## Residual unknown (needs a real `XAI_API_KEY`)

- **Exact model-id string.** `grok models` is auth-gated; default alias is
  `grok-build`, and `-m grok-4.5` was rejected as "unknown model id" *without*
  auth (the local list is empty pre-auth). One authenticated `grok models` call
  resolves whether Hezo pins `grok-4.5`, `grok-build`, or another id. **Not a
  blocker** — defaulting to the `grok-build` alias sidesteps it.
- **Exact `result`-event JSON** (field nesting for `usage`) — inferred from the
  binary's strings + Claude Code parity; confirm against one real run before
  finalizing the parser.

## Watch list (re-verify before/while implementing)

- Grok Build version churn — flags/format may shift between `0.2.x` releases;
  pin the installed version in the Dockerfile and re-run `grok --help` / `grok
  mcp add --help` / `grok inspect --json` on bumps.
- Whether `grok-build` (subscription relay, `grok agent headless` /
  `cli-chat-proxy.grok.com`) ever needs to be *disabled* to force the
  `XAI_API_KEY` → `api.x.ai` path in all cases. The `grok -p` single-turn path
  used the API directly in testing; confirm no fallback to the relay under load.
- pricepertoken catalog coverage + slug mapping for the chosen Grok model.
