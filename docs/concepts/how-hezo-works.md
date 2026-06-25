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

Every major model now ships its own agentic command-line tool — Claude Code, Codex, the
Gemini CLI, and more. Each wraps a model in a loop that reads and writes files, runs
commands, and uses tools, and each has its own strengths and rough edges. Hezo runs every
model on its **own first-party harness** rather than a lowest-common-denominator wrapper,
then sits one level up as a **meta-harness**, wrapping a uniform platform layer around all
of them — so the harness an agent runs on becomes an implementation detail.

> [!NOTE]
> These are usually called *coding* harnesses, but the loop they run — read, write, run a
> command, use a tool, repeat — is general-purpose. **Hezo is for any task, not just
> code** — software, research, marketing, operations — and runs on these harnesses
> precisely because they are the most capable general-purpose agents available.

That platform layer evens out the differences between models:

- **A completeness check on every run.** When an agent decides it's finished, Hezo
  independently judges whether the work *actually* is done before letting the run end — it
  won't stop on failing tests, declare a problem "out of scope", or punt with "I'll leave
  that for later". (One harness, OpenCode, can't support this hook yet.)
- **The same capabilities and safety, whichever model you pick.** Every agent gets the
  same built-in tools, [skills](/docs/concepts/skills), project memory, task board,
  [sandbox](/docs/security/container-isolation), and
  [secret protection](/docs/security/secret-protection) — switching models, or running
  several at once, never changes what an agent can do or how safely it runs.
- **Rough edges smoothed over.** Per-tool differences in how a prompt is delivered, a run
  is configured, and results come back are normalised by Hezo.

So you can put a cheaper model on routine work and a frontier model on the hard problems
and trust that the floor — the tooling, the guardrails, and the security — stays the same
underneath.

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
