---
title: How Hezo works
order: 6
section: Concepts
---

# How Hezo works

A quick tour of the moving parts. None of this is something you operate by hand —
it's what the single `hezo` binary sets up for you.

## The server

Everything runs from one self-contained server process:

- **Web app** — the board where you oversee teams, tasks, budgets, and chat with the
  CEO.
- **API + realtime** — drives the UI and streams agent activity live.
- **Embedded database** — your teams, projects, tasks, and (encrypted) secrets live
  in a local data directory. No external database to run.
- **Egress proxy** — the mandatory exit through which all agent network traffic
  flows, where secret placeholders become real values for allowed hosts only.
- **Docker orchestration** — provisions and manages the containers agents run in.
- **MCP server** — a built-in [Model Context Protocol](/docs/mcp/hezo-mcp-server)
  endpoint, so agents (Hezo's own and external clients) can manage your work.

## Where agents run

Each project gets its own **Docker container** — a private workspace with the project's
code and tools. Agents execute inside it, never on your host directly. All their
outbound traffic is forced through the egress proxy, and the keys used to sign commits
or reach your model never enter the container. See
[Container isolation](/docs/security/container-isolation).

## How a model becomes an agent

You connect one or more **AI providers** (Claude, ChatGPT, Gemini, and more). Each
provider is driven through its native command-line runtime inside the container. An
**agent** is a role (its system prompt, reporting line, budget, and heartbeat) paired
with a model — and you can give any agent its own model. See
[AI model support](/docs/ai-models).

## Hezo is a meta-harness

Every major model now ships its own agentic command-line tool — Anthropic has Claude
Code, OpenAI has Codex, Google has the Gemini CLI, and there are more. Each *harness* wraps
a model in a loop that reads and writes files, runs commands, and uses tools. They are
genuinely good and genuinely different: each has its own strengths, guardrails, and rough
edges. Picking one means inheriting all of its tradeoffs; juggling several by hand means
re-learning each tool and getting inconsistent results depending on which one you happened
to use.

> [!NOTE]
> These are usually called *coding* harnesses because they grew up around software, but the
> loop they provide — read, write, run a command, use a tool, repeat — is general-purpose.
> **Hezo is for any task, not just code** — software, research, marketing, operations — and
> runs each agent on one of these harnesses precisely because they are the most capable
> general-purpose agents available.

Hezo's answer is to sit one level up. It runs each model inside its **own first-party
harness** — Claude drives Claude Code, GPT drives Codex, Gemini drives the Gemini CLI — so
you keep each model's native tooling instead of a lowest-common-denominator wrapper. Then
it wraps a **single, uniform platform layer** around all of them, so the harness an agent
happens to run on becomes an implementation detail rather than something you manage.

That platform layer is what lets Hezo **even out the tradeoffs between harnesses**, so you
get quality results across very different models. Three things do the levelling:

- **A uniform completeness check on every run.** When an agent decides it's finished, Hezo
  independently judges whether the work is *actually* done before letting the run end — it
  won't let an agent stop on failing tests, quietly declare a problem "out of scope", or
  punt with "I'll leave that for later". This discipline rides on top of every harness that
  supports it, which matters most for models that wouldn't hold that line on their own. (One
  harness, OpenCode, can't support the hook yet, so runs there rely on the model alone.)
- **The same capabilities and the same safety, whichever model you choose.** The tools,
  [skills](/docs/concepts/skills), memory, sandbox, and secret protection described
  elsewhere on this page are identical no matter which harness an agent runs on — switching
  a model, or running several at once, never changes what an agent can do or how safely it
  runs.
- **Rough edges smoothed over.** The per-tool differences — how a prompt is delivered, how a
  run is configured, how results come back — are normalised by Hezo, so behaviour stays
  consistent no matter which harness backs an agent.

The practical payoff: put a cheaper model on routine work and a frontier model on the hard
problems, and trust that the *floor* — the tooling, the guardrails, and the security —
stays the same underneath all of them. You never have to choose between a model's native
agentic tooling and a consistent, safe platform around it; you get both.

## How work is organised

- A **project** owns exactly one **team** (its agent roster).
- A team has a **Captain** plus worker roles; an instance-wide **CEO** and **Coach**
  oversee everything from **HQ**.
- Work flows as **tasks** on a board, each with a description, optional rules, and a
  living progress summary.
- Knowledge lives alongside the work: **documents** (markdown PRDs, specs, and research,
  with version history) and an **assets** library (uploads and agent-generated files, with
  HTML previews). See [Documents & long-term memory](/docs/concepts/documents-and-memory)
  and [Assets & previews](/docs/concepts/assets).

See [Projects & teams](/docs/concepts/projects-and-teams) and
[Roles & the CEO](/docs/concepts/roles-and-coordination).

## The three security pillars

| Pillar | What it protects | Read more |
|---|---|---|
| Egress secret substitution | Your API keys and tokens — agents only ever see placeholders | [Secret protection](/docs/security/secret-protection) |
| Master key & encryption | All confidential data at rest | [Master key](/docs/security/master-key) |
| Container isolation | Your host and other projects, if an agent misbehaves | [Container isolation](/docs/security/container-isolation) |
