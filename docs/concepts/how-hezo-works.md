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
