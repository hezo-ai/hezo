<p align="center">
  <img src="assets/logo.svg" alt="Hezo" width="96" height="96" />
</p>

<h1 align="center">Hezo</h1>

<div align="center">
  
[![Update hezo submodule](https://github.com/hezo-ai/hezo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hezo-ai/main/actions/workflows/main.yml)

</div>

<p align="center">
  <strong>A company for your AI agents — self-hosted, and secure by design.</strong>
</p>

<p align="center">
  A coding agent is a contractor. Hezo is the company that hires it, gives it a role and a<br/>
  budget, hands it the keys without letting it keep them, and ships its work —<br/>
  all on hardware you own.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a>
  · <a href="#features">Features</a>
  · <a href="./docs/introduction.md">Docs</a>
  · <a href="https://hezo.ai">Website</a>
  · <a href="https://github.com/hezo-ai/hezo">GitHub</a>
  <!-- TODO(founder): add Discord / X links here once they exist. -->
</p>

<p align="center">
  <img src="assets/hero.png" alt="The Hezo web app — a project task board with its team of AI agents" width="863" />
</p>

<!-- TODO(founder): a 15–20s demo GIF would convert even better than this static shot —
     record the CEO chat → a team spins up → a task runs live, and drop it at .github/assets/demo.gif. -->

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

1. **Create a project.** Describe the work to the [CEO](./docs/concepts/roles-and-coordination.md)
   in plain language; it scopes the project and provisions a
   [team](./docs/concepts/projects-and-teams.md) for you.
2. **Assemble the team.** Start from a [template](./docs/concepts/projects-and-teams.md#team-templates),
   [hire roles](./docs/concepts/hiring-and-agents.md), edit their system prompts, and give
   any agent [its own model](./docs/ai-models.md#give-an-agent-its-own-model).
3. **Approve and run.** Agents pick up [tasks](./docs/concepts/tasks.md) and work
   autonomously on a heartbeat. You set the rules, watch progress live, approve sensitive
   actions, and [cap the spend](./docs/concepts/budgets-and-costs.md).

See [How Hezo works](./docs/concepts/how-hezo-works.md) for the full tour of the moving
parts.

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
by name, never by value. The same posture runs end to end:

- **[Secret protection & egress](./docs/security/secret-protection.md).** Placeholders in,
  real keys swapped in at the network edge only for allowed hosts.
- **[Encrypted at rest](./docs/security/master-key.md).** API keys, tokens, and signing
  keys are encrypted (AES-256-GCM) with a twelve-word master key that lives in memory only
  and is never written to disk — Hezo can't even unlock itself without you.
- **[Container isolation](./docs/security/container-isolation.md).** Every agent runs in a
  per-project Docker container with no host access and all traffic forced through the
  proxy. The blast radius of a bad run is one box.
- **[Activity log & audit trail](./docs/security/activity-log.md).** Every state-changing
  action — and every secret an agent used, by name — is recorded, attributed, and
  impossible to rewrite after the fact.

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

Full details — subscriptions vs. API keys, mixing providers, per-agent overrides — in
[AI model support](./docs/ai-models.md).

## Features

Each feature links to its documentation.

- **[Org chart of agents](./docs/concepts/roles-and-coordination.md)** — instance-wide CEO and Coach, plus a Captain and workers per team.
- **[Real-time CEO chat](./docs/concepts/roles-and-coordination.md#chatting-with-the-ceo)** — one always-on conversation to scope work, hire, and check status, streaming live.
- **[Self-improving teams](./docs/concepts/roles-and-coordination.md#the-coach)** — the Coach reviews finished tickets and writes durable learned rules back onto the agents.
- **[Task board](./docs/concepts/tasks.md)** — tasks with descriptions, per-task rules, and agent-maintained progress summaries.
- **[Heartbeat execution](./docs/getting-started/first-project.md#3-watch-the-team-work)** — agents wake on a schedule to pick up work on their own.
- **[Approvals](./docs/getting-started/first-project.md#4-stay-in-control)** — consequential actions surface for you to confirm.
- **[One team per project](./docs/concepts/projects-and-teams.md)** — independent roster, tasks, budget, and container per project.
- **[Team templates](./docs/concepts/projects-and-teams.md#team-templates)** — start Blank (just a Captain) or with a full software-development roster.
- **[Save & reuse teams](./docs/concepts/projects-and-teams.md#reusing-a-team-setup)** — snapshot a tuned team as the starting point for new projects.
- **[Hire & customize agents](./docs/concepts/hiring-and-agents.md)** — add, retire, and reinstate roles; edit prompts, heartbeats, budgets, and code access.
- **[Per-agent model](./docs/ai-models.md#give-an-agent-its-own-model)** — give any agent its own model; mix providers within one team.
- **[Bring your own models](./docs/ai-models.md)** — Claude, ChatGPT, Gemini, Kimi, DeepSeek, Z.ai, or OpenRouter, each via its native runtime.
- **[Budget caps & cost tracking](./docs/concepts/budgets-and-costs.md)** — daily/weekly/monthly limits per agent and project; runs pause and auto-resume.
- **[Secret substitution](./docs/security/secret-protection.md)** — agents see placeholders; real keys are swapped in at the egress proxy only for allowed hosts.
- **[Encrypted at rest](./docs/security/master-key.md)** — AES-256-GCM behind one twelve-word master key only you hold.
- **[Container isolation](./docs/security/container-isolation.md)** — every agent runs sandboxed, with all traffic forced through the proxy.
- **[Verified git commits](./docs/security/container-isolation.md#keys-never-enter-the-container)** — signed host-side; the signing key never enters the container.
- **[Activity log & audit trail](./docs/security/activity-log.md)** — append-only, attributed record of every action and secret use.
- **[Documents & long-term memory](./docs/concepts/documents-and-memory.md)** — durable markdown PRDs, specs, and research with version history and one-click restore.
- **[Chatbox memory](./docs/concepts/documents-and-memory.md#chatbox-memory)** — the CEO remembers your standing preferences across conversations.
- **[Assets & previews](./docs/concepts/assets.md)** — upload references; agents produce HTML/SVG deliverables you preview in-app, sandboxed.
- **[Search across everything](./docs/concepts/search.md)** — one ⌘K palette finds tasks, comments, docs, and skills across every team, ranked by meaning and indexed on your own server.
- **[Built-in MCP server](./docs/mcp/hezo-mcp-server.md)** — drive your teams and tasks from any MCP client.
- **[External MCP servers](./docs/mcp/connecting-mcp-servers.md)** — give your agents the tools you already use, scoped per instance, team, or project.
- **[Self-hosted single binary](./docs/getting-started/installation.md)** — no runtime or external database; Docker is the only prerequisite. [Configurable](./docs/deployment/configuration.md) by flag or env, with a small [CLI](./docs/reference/cli.md).
- **[Deploy anywhere Docker runs](./docs/deployment/self-hosting.md)** — laptop, home server, or [cloud VPS](./docs/deployment/cloud.md), with [secure remote access](./docs/deployment/secure-remote-access.md) and [safe-rollback backups](./docs/deployment/backup-and-recovery.md).
- **[In-app self-update](./docs/deployment/self-hosting.md#updating)** — Hezo checks for new releases, downloads and verifies the binary, then swaps it in and restarts from the web UI — no manual binary replacement.
- **Mobile-first web app** — oversee, chat, and approve from any device.

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

<!-- TODO(founder): add Discord / X links once they exist, and choose a license + add a
     LICENSE file, then state it here (and a badge above). -->
