<p align="center">
  <img src="assets/logo.svg" alt="Hezo" width="96" height="96" />
</p>

<h1 align="center">Hezo</h1>

<div align="center">
  
[![Update hezo submodule](https://github.com/hezo-ai/hezo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hezo-ai/main/actions/workflows/main.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](./LICENSE.md)

</div>

<p align="center">
  <strong>A whole AI workforce. Self-hosted and secure.</strong>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a>
  · <a href="#features">Features</a>
  · <a href="./docs/introduction.md">Docs</a>
  · <a href="https://hezo.ai">Website</a>
  · <a href="https://github.com/hezo-ai/hezo">GitHub</a>
  · <a href="https://x.com/taoofdev">X</a>
</p>

<p align="center">
  <img src="assets/hero.png" alt="The Hezo web app — a project task board with its team of AI agents" width="863" />
</p>


## What is Hezo?

Hezo is a self-hosted server and web app for running **teams of AI agents like an
organisation**. You stand up a CEO, a Captain, engineers, designers, researchers —
whatever the work needs — with org charts, projects, budgets, and approvals built in. You
manage goals and projects, not twenty terminal tabs.

Because those agents run real, often AI-written code, Hezo is **secure by design**: agents
never see your real secrets, everything sensitive is encrypted behind a key only you hold,
and every agent runs sandboxed in its own container. You own the machine, the model keys,
the spend, and the data.

New here? Start with the [Introduction](./docs/introduction.md) and
[How Hezo works](./docs/concepts/how-hezo-works.md).

## Quickstart

Hezo ships as a **single self-contained binary** — nothing to compile, no runtime or
dependencies to install, so you're up in seconds. The fastest way to get it is the
one-line installer, which detects your OS and CPU architecture and downloads the
matching [release binary](https://github.com/hezo-ai/hezo/releases/latest). Docker is
the only prerequisite (agents run in isolated containers).

**macOS / Linux**

```sh
curl -fsSL https://hezo.ai/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://hezo.ai/install.ps1 | iex
```

Then start the server:

```sh
hezo
```

Open **http://localhost:3100** and follow the [first-run setup](./docs/getting-started/first-run.md)
to create your master key and connect a model. From there, see
[Your first project](./docs/getting-started/first-project.md).

Prefer a manual download? Grab the binary for your platform straight from
[GitHub Releases](https://github.com/hezo-ai/hezo/releases/latest). Full steps and the
per-platform asset names are in [Installation](./docs/getting-started/installation.md).

### Build from source

Want to hack on Hezo or run an unreleased build? You'll need [Bun](https://bun.sh/)
v1.3.14+ and Docker.

```sh
git clone https://github.com/hezo-ai/hezo.git
cd hezo
bun install
bun run dev
```

## How it works

1. **Create a project and pick a team.** Start from a
   [template](./docs/concepts/projects-and-teams.md#team-templates), or ask the
   [CEO](./docs/concepts/roles-and-coordination.md) to help you assemble a
   [team](./docs/concepts/projects-and-teams.md) for the work.
2. **Set the direction.** Specify the project plan, [hire or customize
   agents](./docs/concepts/hiring-and-agents.md), edit their prompts, and give any agent
   [its own model](./docs/ai-models.md#give-an-agent-its-own-model).
3. **The team gets to work.** Agents pick up [tasks](./docs/concepts/tasks.md) and work
   autonomously, asking for your [approval](./docs/getting-started/first-project.md#4-stay-in-control)
   when needed — and you can change direction at any time.

See [How Hezo works](./docs/concepts/how-hezo-works.md) for the full tour of the moving
parts.

## Features

- **Agents organised like a company** — an instance-wide [CEO and Coach](./docs/concepts/roles-and-coordination.md) sit above a Captain and workers per team; [chat with the CEO live](./docs/concepts/roles-and-coordination.md#chatting-with-the-ceo) to scope work and hire, while the [Coach](./docs/concepts/roles-and-coordination.md#the-coach) reviews finished tickets and writes durable learned rules back onto the agents.
- **Teams & projects** — [one team per project](./docs/concepts/projects-and-teams.md) with its own roster, budget, and container; start from a [template](./docs/concepts/projects-and-teams.md#team-templates), [hire and customize agents](./docs/concepts/hiring-and-agents.md), and [snapshot a tuned team](./docs/concepts/projects-and-teams.md#reusing-a-team-setup) to reuse on new projects.
- **Autonomous task execution** — a [task board](./docs/concepts/tasks.md) with per-task rules and agent-maintained progress summaries; agents wake on a [heartbeat](./docs/getting-started/first-project.md#3-watch-the-team-work) to pick up work on their own and surface [approvals](./docs/getting-started/first-project.md#4-stay-in-control) for consequential actions.
- **Steer by outcome with goals** — set high-level [goals and a project progress view](./docs/concepts/goals.md); the Captain re-checks each goal on a schedule, writing a fresh progress estimate, health, and status, and keeps a project progress summary up to date — so you can see where a project stands without reading every ticket.
- **Your models, your spend** — [bring your own providers](./docs/ai-models.md) (Claude, ChatGPT, Gemini, Kimi, DeepSeek, Z.ai, OpenRouter, xAI Grok), each via its native runtime; [give any agent its own model](./docs/ai-models.md#give-an-agent-its-own-model) and set [budget caps with cost tracking](./docs/concepts/budgets-and-costs.md) that pause and auto-resume runs.
- **Secure by design** — agents see [placeholders, not secrets](./docs/security/secret-protection.md) (real keys swapped in at the egress proxy only for allowed hosts), everything is [encrypted at rest](./docs/security/master-key.md) behind one twelve-word master key, every agent runs in a [sandboxed container](./docs/security/container-isolation.md), [git commits are signed host-side and land verified](./docs/security/git-and-verified-commits.md), and an [append-only audit trail](./docs/security/activity-log.md) records every action and secret use.
- **Teams that improve themselves** — when a ticket is finished, the [Coach](./docs/concepts/coach-and-self-improving-teams.md) reviews how it went and writes durable **learned rules** back onto the agents, so they get better the more they ship — no manual prompt-tuning.
- **Knowledge & memory, versioned and reversible** — durable [documents](./docs/concepts/documents-and-memory.md) for PRDs, specs, and research, reusable cross-team [skills](./docs/concepts/skills.md), and agent system prompts — all with [full revision history and one-click restore](./docs/concepts/documents-and-memory.md#version-history); plus [CEO chatbox memory](./docs/concepts/documents-and-memory.md#chatbox-memory) for your standing preferences, [assets and sandboxed previews](./docs/concepts/assets.md), and [semantic search](./docs/concepts/search.md) across tasks, comments, docs, and skills.
- **MCP, in and out** — a [built-in MCP server](./docs/mcp/hezo-mcp-server.md) to drive your teams and tasks from any MCP client, plus [external MCP servers](./docs/mcp/connecting-mcp-servers.md) to give your agents the tools you already use, scoped per instance, team, or project.
- **Your data, on an embedded database** — Hezo carries its [own database](./docs/concepts/your-data.md) inside the binary, so there's **no external database to run** and your work stays on hardware you own, with **safe, data-preserving upgrades** that snapshot and roll back automatically.
- **Self-hosted & easy to run** — a [single binary](./docs/getting-started/installation.md), [deployable anywhere Docker runs](./docs/deployment/self-hosting.md) with [secure remote access](./docs/deployment/secure-remote-access.md) and [safe-rollback backups](./docs/deployment/backup-and-recovery.md), [in-app self-update](./docs/deployment/self-hosting.md#updating), and a mobile-first web app to oversee, chat, and approve from any device.

## Agents never hold your secrets

This is the part most agent setups get wrong, and a big reason Hezo exists. Agents
reference every credential by a **placeholder** — never the real value:

```http
Authorization: Bearer __HEZO_SECRET_STRIPE__
```

The real key lives encrypted in Hezo's vault. When the request leaves the container, the
**egress proxy** checks the destination against that secret's allowed hosts and swaps in
the real value only if it matches — say, `api.stripe.com`. Send it anywhere else and the
proxy blocks the request; the substitution simply never happens.

So a buggy, jailbroken, or outright malicious agent **cannot leak what it never sees**. It
can only use a secret against the hosts you scoped it to, and every substitution is logged
by name, never by value. The same posture runs end to end — encrypted at rest behind your
master key, every agent sandboxed in its own container, and an append-only audit trail of
every action and secret use. See the [security documentation](./docs/security/secret-protection.md)
for the full picture.

It's all **[yours](./docs/deployment/self-hosting.md)**: self-hosted, your model accounts,
your spend, your data.

## Works with your models

Bring your own provider accounts — connect as many as you like, and give any individual
agent [its own model](./docs/ai-models.md#give-an-agent-its-own-model). Each provider is
driven through its **native command-line runtime** inside the container, so you get each
model's first-party agentic tooling, not a lowest-common-denominator wrapper.

| Provider | Models | Runtime | Auth |
|---|---|---|---|
| **Anthropic** | Claude | Claude Code | API key or subscription |
| **OpenAI** | ChatGPT / GPT | Codex | API key or subscription |
| **Google** | Gemini | Gemini CLI | API key or subscription |
| **Kimi** (Moonshot) | Kimi | Kimi | API key or subscription |
| **DeepSeek** | DeepSeek | Claude Code | API key |
| **Z.ai** | GLM | Claude Code | API key |
| **OpenRouter** | Many, via one key | OpenCode | API key |
| **xAI** | Grok | Grok Build | API key |

Full details — subscriptions vs. API keys, mixing providers, per-agent overrides — in
[AI model support](./docs/ai-models.md).

## How Hezo compares

|  | Agents in terminal tabs | Hosted agent platforms | Agent frameworks / SDKs | **Hezo** |
|---|---|---|---|---|
| Runs on | Your machine, by hand | Someone else's cloud | Wherever you build it | **Hardware you own** |
| Your secrets | Live in your shell | Held by the vendor | You wire them up | **Never exposed to the agent** |
| Many agents | Tabs and willpower | Varies | You build it | **An org chart, built in** |
| Spend control | Watch the meter | Vendor billing | Do it yourself | **Hard budget caps** |
| You provide | Prompts, by hand | Vendor config | Code | **Goals and rules** |

## Development

Contributor setup, scripts, and the testing guide live in
[`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md).

```sh
bun install
bun run dev        # server + web UI on http://localhost:3100
bun run test       # the full test suite
```

## Community & license

Questions and bug reports are welcome via
[GitHub Issues](https://github.com/hezo-ai/hezo/issues).

Copyright (C) 2026 [Ramesh Nair](https://hiddentao.com).

Hezo is licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE.md).

X: [@taoofdev](https://x.com/taoofdev)