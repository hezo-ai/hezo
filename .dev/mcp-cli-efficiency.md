# hezo-mcp CLI efficiency: measured savings

Why connector tools live behind the in-container `hezo-mcp` CLI instead of the
runtime's MCP config, with numbers from a real project run end to end. The
mechanism itself is described in `architecture.md` ("Connector tools are reached
through an in-container CLI"); this file records what it saves, so the design
can be re-argued from data rather than intuition when someone proposes loading
tools natively again - or proposes the opposite, moving Hezo's own API behind
the CLI.

## The workload measured

One project ("Todo App", 2026-08-23/24, Codex runtime throughout): a 12-role
team planned, designed, built, QA'd, security-reviewed, released and deployed a
web app to Netlify. One connector was attached: GitHub's hosted MCP server with
7 toolsets enabled.

| Quantity | Value | Source |
|---|---|---|
| Connector tool schemas | 48 tools, 132,070 bytes (~33k tokens) | the CLI's per-run `.cache/github.json` |
| Runs carrying the connector | 133 of 134 | run logs' `[runner] MCP connectors:` line |
| Model requests (approximated as tool calls + 1 per run) | 20,975 | `heartbeat_runs.tool_call_counts` |
| Context actually processed | 540M tokens (276M fresh + 264M cached) | `heartbeat_runs` token columns |
| `hezo-mcp` invocations | 612 (284 call, 157 describe, 131 search, 40 servers) | run-log grep |
| Native Hezo tool calls | 20,886 across 44 of the 84 tools | `tool_call_counts` |

Caveats: bytes-to-tokens assumes ~4 chars/token for JSON schema (±20%);
requests-per-tool-call ignores parallel calls (overcounts) but Codex shell
commands are absent from `tool_call_counts` (undercounts, and by more), so the
savings below are conservative. One pathological run (see below) contributes
18,766 of the requests; figures are given with and without it.

## What native loading would have cost

Natively-loaded schemas ride every request: uncached on a run's first request,
cache-priced reads after. OpenAI-style cache pricing bills reads at ~10%.

| Metric | All runs | Excluding the outlier |
|---|---|---|
| Schema context avoided | ~692M tokens | ~73M tokens |
| ...as a share of total context | -56% | -12% |
| Billed-token equivalent saved | ~73M | ~11M |
| CLI overhead paid (prompt block + interactions) | ~1M | ~0.5M |
| Return on overhead | ~70:1 | ~20:1 |

Agents fetched 157 tool schemas on demand all project (~104k tokens) versus the
~692M blanket loading would have pushed: a ~6,600x reduction in schema traffic.
This is the minimum case - one 48-tool connector. At the ~255-tool instance the
design targets (~90k tokens per request), the avoided volume approaches 1.9B on
the same workload.

## Why Hezo's own API stays native

The same data argues against moving the 84 `mcp__hezo__*` tools behind the CLI:

- **They are ~74x hotter**: 20,886 native calls vs 284 connector calls. Their
  schema cost amortizes across constant use and is cache-priced after each
  run's first request; connector schemas were dead weight because they were
  always loaded and almost never used.
- **The CLI adds round trips**: first use becomes search, describe, call -
  three model requests where a native call is one. On workhorse tools that
  inverts the savings.
- **Native calls keep runtime-enforced schemas and retries**; shell-quoted JSON
  is a reliability downgrade for the tools correctness depends on.

The measured refinement if context pressure grows: 40 of the 84 tools were
never called this project. Defer that cold tail (decided from
`tool_call_counts`, never by guess), keep the hot core native.

## Reproducing the measurement

Snapshot `pgdata` and read it with PGlite (see the memory note on reading the
live DB). Schemas: read `.cache/<connector>.json` beside a live run's manifest.
Requests: sum `tool_call_counts` per run, +1 each. Connector presence: grep run
logs for `[runner] MCP connectors:`. CLI usage: grep run logs for `hezo-mcp `
subcommands.

## Known outlier

Run `38e84ea8` (Coach) made 18,765 `get_run_log` calls in one run - a runaway
log-paging loop, tracked separately. Its existence cuts both ways: it inflates
the headline savings, and it shows a single misbehaving run can multiply
whatever rides per-request context.
