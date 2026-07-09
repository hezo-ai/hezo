# Grok Build support — Design & Feasibility Assessment

Assessment of adding **xAI Grok Build** (the `grok` CLI, `grok-build` /
`grok-4.5`) back as a Hezo AI provider + runtime, written 2026-07. This is a
**decision reference and implementation plan**, not a commitment. The
runtime-capability claims below were verified empirically against **Grok Build
`0.2.93` (linux-x86_64)** installed and probed in a Hezo container on the date
above — not from the docs, which lag the CLI. External facts (CLI flags, stream
schema, model ids) will drift; re-run the probes in "How the facts were
verified" before acting.

**Verdict up front:** re-adding Grok is **feasible** and cheaper than the first
attempt (PR #460, reverted in #481), with **two real caveats** that shape the
work. Grok Build is heavily **Claude-Code-compatible** — it reads
`.claude/settings.json`, mirrors Claude Code's permission modes /
`--system-prompt` override / MCP `config.toml` shape — so the adapter is a near
clone of the existing Claude Code one. But two things are *not* free:

1. **Token/cost accounting needs a non-standard path.** Grok Build's headless
   output (`--output-format json` **and** `streaming-json`) and its on-disk
   session files carry **no token counts at all**. Usage is only recoverable by
   running with `--debug-file <path>` and parsing the per-turn tracing spans
   (`input_tokens=` / `output_tokens=` / `cache_read_tokens=`). This is
   deterministic but is log-span parsing, not clean JSON — and the debug file
   contains the `XAI_API_KEY` in plaintext, so it must be scrubbed after
   extraction. (An earlier draft of this doc claimed usage was in the stream
   `result` event, inferred from the binary's strings — that was **wrong**; a
   real authenticated run has no such event.)
2. **The completeness judge is omitted (fail-open), like OpenCode.** Confirmed
   authoritatively from the ACP handshake: `"x.ai/hooks":{"blockingEvents":
   ["pre_tool_use"],"decisions":["deny"]}`. Only `pre_tool_use` can block;
   `Stop`/`SessionEnd` are passive and cannot block-and-continue, which Hezo's
   judge requires.

Recommended path: **native `grok` runtime on `grok-4.5`, judge omitted, token
usage parsed from `--debug-file`.** The alternative (route `grok-4.5` through
Codex's OpenAI-compatible provider) both keeps the Stop judge *and* gives clean
`usage` JSON — at the cost of running the model outside its native harness. If
the debug-log cost path proves too brittle, that alternative becomes the
recommendation; see "Rejected alternative" and "Cost accounting".

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

A later authenticated pass (real `XAI_API_KEY`) added: `grok models`, a real
1-turn `--output-format json`/`streaming-json` capture, inspection of the
on-disk session files (`~/.grok/sessions/**`), and a `--debug-file` run. Those
resolved the model id and the token-usage question (see "Cost accounting").

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
| Structured output for the parser | `--output-format streaming-json` | Typed events, but **not** the Claude Code `stream-json` shape: `{"type":"thought","data":…}` (reasoning), `{"type":"text","data":…}` (assistant text), `{"type":"end","stopReason":…,"sessionId":…,"requestId":…}`. `--output-format json` returns one object `{text, stopReason, sessionId, requestId, thought}`. **Neither carries token usage.** |
| **Token/cost accounting** | **Only** via `--debug-file <path>` → parse `process_conversation_turn` spans (`input_tokens=` / `output_tokens=` / `cache_read_tokens=`, per turn) | Not in JSON/stream output, not in session files. See "Cost accounting" — this is the biggest implementation wrinkle. Prices from the table as always once the counts are recovered. |
| System prompt injection | `--system-prompt-override <prompt>` (+ `--rules`) | Hezo injects the agent's home-team system prompt. |
| Auto-approve tools (headless) | `--permission-mode bypassPermissions` (or `--always-approve`) | **Required** — without it, tool calls block on approval and a headless run hangs. |
| Turn cap | `--max-turns <N>` | Native. |
| Model selection | `-m <model>` | Authenticated `grok models` list: `grok-4.5`, `grok-build-0.1`, `grok-4.3`, `grok-4.20-0309-{non-,}reasoning`, `grok-4.20-multi-agent-0309` (+ `grok-imagine-*` media). All report `totalContextTokens: 256000`. Default agent is `grok-build-plan`. **`grok-4.5` is valid.** Consider `grok-build-0.1` (the coding-tuned model) as an alternative default. |
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
`SubagentStop`, `PreCompact`, … **but only `PreToolUse` is a blocking event**.
This is confirmed authoritatively by the CLI's own ACP `initialize` handshake
(captured via `--debug-file`):

```json
"x.ai/hooks": { "blockingEvents": ["pre_tool_use"], "decisions": ["deny"] }
```

`Stop`/`SessionEnd` are **passive notifications** — they fire *after* the agent
has decided to stop and cannot force it to continue. There is no
`decision:"block"` / `stop_hook_active` equivalent.

Hezo's completeness judge requires **block-and-continue** at turn end (Claude
Code prompt `Stop`, Codex command `Stop`, Gemini `AfterAgent`). Grok can't
provide it. **Therefore the judge is omitted for the Grok runtime — fail-open,
identical to OpenCode** (`AGENTS.md` § "AI runtime hooks": OpenCode already runs
with the judge omitted for the same "can't block-and-continue" reason).

Native mitigations available if we want a softer floor (optional, not v1):

- `--max-turns <N>` — hard turn budget.
- `--check` — "append a self-verification loop to the prompt (headless only)".
- `--best-of-n <N>` — run the task N ways, pick the best (headless only).

## Cost accounting — the biggest wrinkle

Hezo prices every run in `agent-stream-parser.ts` from the token buckets the
runtime reports, then multiplies by the `model_pricing` table. **Grok Build
reports no token counts on any clean surface** — verified against a real
authenticated run:

- `--output-format json` → `{text, stopReason, sessionId, requestId, thought}`.
  No usage.
- `--output-format streaming-json` → `thought`/`text`/`end` events. No usage.
- On-disk session files (`~/.grok/sessions/<id>/{events,chat_history,updates}.jsonl`,
  `summary.json`) → no usage; `turn_ended` carries only `outcome`.

Usage **is** available in the `--debug-file` tracing output, one span per turn:

```
… session.process_conversation_turn{ … model_id="grok-4.5" request_id="…"
  ttft_ms=951 input_tokens=10586 output_tokens=9 cache_read_tokens=4352
  stop_reason="stop" response.has_tool_call=false }: …
```

Fields: `input_tokens`, `output_tokens`, `cache_read_tokens` (note: **not** the
`cache_read_input_tokens` name; no `cache_creation` bucket observed). So the
native-runtime cost path is: run with `--debug-file <path>`, then sum
`input_tokens`/`output_tokens`/`cache_read_tokens` across the
`process_conversation_turn` spans and feed the existing table-pricing.

Caveats to design around:

- It's **log-span parsing**, not stable JSON — brittle across CLI versions.
  Pin the version and add a parser test against a captured fixture; on a bump,
  re-verify the span format.
- The debug file **contains `XAI_API_KEY` in plaintext** (it logs the full
  `SamplerConfig`). Write it to a run-local path, parse it host-side, and
  **scrub it immediately** after extraction. The key is already the sanctioned
  in-run plaintext credential, so this is not a new leak class, but the file
  must not be persisted or shipped anywhere.
- If this proves too brittle, the clean fallback is the **Codex path** (below),
  whose OpenAI-compatible `usage` object Hezo can read directly — this is the
  single strongest argument for the Codex alternative.

## Implementation plan (recommended: native runtime, judge omitted)

**0. Spike done** (this doc). CLI installed & probed; model id (`grok-4.5`),
MCP/hook formats, egress host, and the `--debug-file` usage path are all
confirmed against a real key. No open spike items remain.

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
  --permission-mode bypassPermissions -m grok-4.5 --max-turns <n>
  --system-prompt-override <prompt> --debug-file <run-local path>`.
- `--debug-file` is **required** for cost accounting (see "Cost accounting"),
  not optional. Scrub it after parsing (it holds the API key).
- Egress: `api.x.ai` direct, `XAI_API_KEY` env-injected.
- Decide on `--disable-web-search`: Grok's built-in web-search/fetch tools route
  through xAI infra — an egress-surface decision (leave on for capability, or
  disable for a tighter allowlist).

**4. Stream parser + cost — `agent-stream-parser.ts`**
- Parse the `thought`/`text`/`end` stream for transcript/output (new shape, not
  the Claude Code `stream-json` shape).
- **Token usage comes from the `--debug-file` `process_conversation_turn`
  spans**, not the stream — sum `input_tokens`/`output_tokens`/`cache_read_tokens`
  across turns. Add a fixture-based parser test; scrub the debug file after.
- Confirm `pricepertoken.com` carries the chosen Grok model and that model-id
  normalization maps `grok-4.5` to the catalog slug (unpriced ⇒ silent $0).

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
`base_url=https://api.x.ai/v1`, `wire_api="chat"`). It buys **two** things the
native runtime can't: it **preserves the Codex `Stop` command-hook judge**, and
its OpenAI-compatible responses carry a clean `usage` object, so **cost
accounting is trivial** (no debug-log parsing). The cost is running `grok-4.5`
inside OpenAI's agent harness rather than Grok Build's own — xAI ships `grok-4.5`
specifically to drive Grok Build, so raw agent quality likely suffers.

Net: pick the native runtime for **quality**, the Codex path for **operational
cleanliness** (judge + easy cost). If the `--debug-file` cost path proves too
brittle in practice, the Codex path is the fallback — and it is a stronger
fallback than the "back pocket" framing of the earlier draft implied.

## Residual unknowns — now resolved (via authenticated run)

- **Model id — resolved.** `grok-4.5` is a valid `-m` value (full list in the
  Runtime-mapping table). `grok-build-0.1` (coding-tuned) is a viable alternative
  default. The `grok-build` name is only the *default alias*, not required.
- **Usage schema — resolved (and it corrected an earlier error).** No usage in
  the stream/JSON output or session files; usage lives in the `--debug-file`
  `process_conversation_turn` spans (`input_tokens`/`output_tokens`/
  `cache_read_tokens`). See "Cost accounting".
- **Hook blocking capability — resolved.** ACP handshake advertises
  `blockingEvents:["pre_tool_use"]` only. Judge stays omitted.

## Watch list (re-verify before/while implementing)

- Grok Build version churn — flags/format may shift between `0.2.x` releases;
  pin the installed version in the Dockerfile and re-run `grok --help` / `grok
  mcp add --help` / `grok inspect --json` on bumps. The `--debug-file` span
  format is the most fragile dependency — re-verify it on every bump.
- Whether `grok-build` (subscription relay, `grok agent headless` /
  `cli-chat-proxy.grok.com`) ever needs to be *disabled* to force the
  `XAI_API_KEY` → `api.x.ai` path in all cases. The `grok -p` single-turn path
  used the API directly in testing; confirm no fallback to the relay under load.
- pricepertoken catalog coverage + slug mapping for the chosen Grok model.
