<p align="center">
  <img src="assets/logo.svg" alt="Hezo" width="96" height="96" />
</p>

<h1 align="center">Hezo</h1>

<div align="center">
  
[![Update hezo submodule](https://github.com/hezo-ai/hezo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hezo-ai/main/actions/workflows/main.yml)
[![Coverage Status](https://coveralls.io/repos/github/hezo-ai/hezo/badge.svg?branch=main)](https://coveralls.io/github/hezo-ai/hezo?branch=main)
[![License: GPL v3](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](./LICENSE.md)
[![Languages: 12](https://img.shields.io/badge/languages-12-brightgreen.svg)](./docs/concepts/languages-and-formats.md)

</div>

<p align="center">
  <sub>
    🌐
    English · Deutsch · Français · Español · Italiano · Português (Brasil) ·
    Nederlands · Polski · Svenska · 简体中文 · 日本語 · 한국어
  </sub>
</p>

<p align="center">
  <a href="https://ssh.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/hezo-ai/hezo&cloudshell_workspace=deploy/gcp&cloudshell_tutorial=tutorial.md"><img src="https://img.shields.io/badge/Deploy_on-Google_Cloud-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white" alt="Deploy on Google Cloud" height="28" /></a>
  <a href="https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://hezo-deploy.s3.us-east-1.amazonaws.com/hezo.cfn.yaml&stackName=hezo"><img src="https://img.shields.io/badge/Deploy_on-AWS-FF9900?style=for-the-badge&logo=amazonwebservices&logoColor=white" alt="Deploy on AWS" height="28" /></a>
  <a href="./docs/deployment/one-click.md"><img src="https://img.shields.io/badge/Deploy_on-DigitalOcean-0080FF?style=for-the-badge&logo=digitalocean&logoColor=white" alt="Deploy on DigitalOcean" height="28" /></a>
</p>

<p align="center">
  <strong>Your own team of AI agents. Built to deliver.</strong>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a>
  · <a href="#features">Features</a>
  · <a href="./docs/introduction.md">Docs</a>
  · <a href="https://hezo.ai">Website</a>
  · <a href="https://github.com/hezo-ai/hezo">GitHub</a>
  · <a href="https://x.com/hezo_ai">X</a>
</p>

<p align="center">
  <img src="assets/hero.png" alt="The Hezo web app - a project task board with its team of AI agents" width="863" />
</p>


## What is Hezo?

Hezo is a self-hosted server and web app for running **teams of AI agents like an
organisation**. You stand up a CEO, a Captain, engineers, designers, researchers -
whatever the work needs - with org charts, projects, budgets, and approvals built in. You
manage goals and projects, not twenty terminal tabs.

Because those agents run real, often AI-written code, Hezo is **secure by design**: agents
never see your real secrets, everything sensitive is encrypted behind a key only you hold,
and every project runs sandboxed in its own container. You own the machine, the model keys,
the spend, and the data.

New here? Start with the [Introduction](./docs/introduction.md) and
[How Hezo works](./docs/concepts/how-hezo-works.md).

## Quickstart

Hezo ships as a **single self-contained binary** - nothing to compile, no runtime or
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

### Deploy to a cloud server

Want an always-on instance instead of running it on your laptop? Deploy to a cloud
VM in a couple of minutes. Each provisions Docker, the binary, automatic HTTPS
(a real cert via `<ip>.sslip.io` - no domain needed), systemd, and a locked-down
firewall, and drops you at the in-browser setup.

<p>
  <a href="https://ssh.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/hezo-ai/hezo&cloudshell_workspace=deploy/gcp&cloudshell_tutorial=tutorial.md"><img src="https://img.shields.io/badge/Deploy_on-Google_Cloud-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white" alt="Deploy on Google Cloud" height="34" /></a>
  <a href="https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://hezo-deploy.s3.us-east-1.amazonaws.com/hezo.cfn.yaml&stackName=hezo"><img src="https://img.shields.io/badge/Deploy_on-AWS-FF9900?style=for-the-badge&logo=amazonwebservices&logoColor=white" alt="Deploy on AWS" height="34" /></a>
  <a href="./docs/deployment/one-click.md"><img src="https://img.shields.io/badge/Deploy_on-DigitalOcean-0080FF?style=for-the-badge&logo=digitalocean&logoColor=white" alt="Deploy on DigitalOcean" height="34" /></a>
</p>

**Google Cloud** and **AWS** are one-click today - Google Cloud opens Cloud Shell
and runs the deploy, and AWS opens a CloudFormation **Launch Stack** (pick a size,
then **Create stack**). **DigitalOcean** opens a short guide until its
[Marketplace image](./deploy/marketplace/digitalocean/README.md) is listed. Any
provider that takes cloud-init works too - see
[One-click deploy](./docs/deployment/one-click.md).

> Hezo runs each project's agents in a container on the host Docker socket, so it
> needs a **real VM** - not a managed-container PaaS (Render, Railway, Cloud Run).
> That's why these buttons target VM providers.

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
   when needed - and you can change direction at any time.

See [How Hezo works](./docs/concepts/how-hezo-works.md) for the full tour of the moving
parts.

## Features

- **Agents organised like a company** - a global [CEO and Coach](./docs/concepts/roles-and-coordination.md) above a per-team Captain and workers, [live CEO chat](./docs/concepts/roles-and-coordination.md#chatting-with-the-ceo), automatic [Coach](./docs/concepts/roles-and-coordination.md#the-coach) reviews.
- **Teams & projects** - [one team per project](./docs/concepts/projects-and-teams.md), start from a [template](./docs/concepts/projects-and-teams.md#team-templates), [hire and customize agents](./docs/concepts/hiring-and-agents.md), [snapshot a team](./docs/concepts/projects-and-teams.md#reusing-a-team-setup) to reuse.
- **Autonomous task execution** - a [task board](./docs/concepts/tasks.md), [heartbeat](./docs/getting-started/first-project.md#3-watch-the-team-work) wake-ups, [approvals](./docs/getting-started/first-project.md#4-stay-in-control), auto-resumed long runs.
- **Steer by outcome** - high-level [goals and a progress view](./docs/concepts/goals.md), scheduled Captain re-checks, up-to-date project summaries.
- **Your models, your spend** - [bring your own providers](./docs/ai-models.md), [per-agent models](./docs/ai-models.md#give-an-agent-its-own-model), [budget caps and cost tracking](./docs/concepts/budgets-and-costs.md).
- **Secure by design** - [secret placeholders](./docs/security/secret-protection.md), [encryption at rest](./docs/security/master-key.md), [admin password sign-in](./docs/security/master-key.md#your-password-vs-the-master-key), [sandboxed containers](./docs/security/container-isolation.md), [verified git commits](./docs/security/git-and-verified-commits.md), an [audit trail](./docs/security/activity-log.md).
- **Teams that improve themselves** - the [Coach](./docs/concepts/coach-and-self-improving-teams.md) writes durable learned rules back onto agents after each finished task.
- **Knowledge & memory** - [documents](./docs/concepts/documents-and-memory.md), [skills](./docs/concepts/skills.md), [version history and restore](./docs/concepts/documents-and-memory.md#version-history), [CEO chatbox memory](./docs/concepts/documents-and-memory.md#chatbox-memory), [assets](./docs/concepts/assets.md), [full-text search](./docs/concepts/search.md).
- **MCP, in and out** - a [built-in MCP server](./docs/mcp/hezo-mcp-server.md), [external MCP servers](./docs/mcp/connecting-mcp-servers.md) scoped per instance, team, or project.
- **Chat from anywhere** - run the CEO from [Telegram](./docs/chat/telegram.md), [Slack](./docs/chat/slack.md), and [Discord](./docs/chat/discord.md), as a [private assistant or a coworker](./docs/chat/overview.md#two-modes-assistant-and-coworker) in your team channels.
- **Your data, in your storage** - [embedded Postgres](./docs/concepts/your-data.md), optional [hosted Postgres](./docs/deployment/configuration.md), local or [S3-compatible](./docs/deployment/configuration.md#storing-assets-in-s3-compatible-object-storage) [asset storage](./docs/concepts/assets.md#where-asset-files-live), data-preserving upgrades.
- **Speaks your language** - the web app runs in [12 languages](./docs/concepts/languages-and-formats.md), picked from your browser on first run and set before anything else; [date and currency formats](./docs/concepts/languages-and-formats.md#date-and-currency-formats) are chosen independently, so ISO dates with German prose is a valid combination.
- **Self-hosted & easy to run** - a [single binary](./docs/getting-started/installation.md), [deployable anywhere Docker runs](./docs/deployment/self-hosting.md), [one-click cloud-init](./docs/deployment/one-click.md), [secure remote access](./docs/deployment/secure-remote-access.md), [safe-rollback backups](./docs/deployment/backup-and-recovery.md), [in-app self-update](./docs/deployment/self-hosting.md#updating), a mobile-first web app.

## Agents never hold your secrets

This is the part most agent setups get wrong, and a big reason Hezo exists. Agents
reference every credential by a **placeholder** - never the real value:

```http
Authorization: Bearer __HEZO_SECRET_STRIPE__
```

The real key lives encrypted in Hezo's vault. When the request leaves the container, the
**egress proxy** checks the destination against that secret's allowed hosts and swaps in
the real value only if it matches - say, `api.stripe.com`. Send it anywhere else and the
proxy blocks the request; the substitution simply never happens.

So a buggy, jailbroken, or outright malicious agent **cannot leak what it never sees**. It
can only use a secret against the hosts you scoped it to, and every substitution is logged
by name, never by value. The same posture runs end to end - encrypted at rest behind your
master key, every project sandboxed in its own container, and an append-only audit trail of
every action and secret use. See the [security documentation](./docs/security/secret-protection.md)
for the full picture.

It's all **[yours](./docs/deployment/self-hosting.md)**: self-hosted, your model accounts,
your spend, your data.

## Works with your models

Bring your own provider accounts - connect as many as you like, and give any individual
agent [its own model](./docs/ai-models.md#give-an-agent-its-own-model). Each provider is
driven through its **native command-line runtime** inside the container, so you get each
model's first-party agentic tooling, not a lowest-common-denominator wrapper.

| Provider | Models | Runtime | Auth |
|---|---|---|---|
| **Anthropic** | Claude | Claude Code | API key or subscription |
| **OpenAI** | ChatGPT / GPT | Codex | API key or subscription |
| **Google** | Gemini | Gemini CLI | API key or subscription |
| **xAI** | Grok | Grok Build | API key |
| **Kimi** (Moonshot) | Kimi | Claude Code | API key |
| **DeepSeek** | DeepSeek | Claude Code | API key |
| **Z.ai** | GLM | Claude Code | API key |
| **OpenRouter** | Many, via one account | OpenCode | API key |
| **Ollama** | Whatever you run locally | Claude Code | Server URL (no key) |
| **LM Studio** | Whatever you run locally | Claude Code | Server URL (no key) |

Ollama and LM Studio run agents **entirely on your own hardware** at no per-token cost -
point Hezo at your server URL and leave the key blank.

Full details (subscriptions vs. API keys, mixing providers, per-agent overrides) in
[AI model support](./docs/ai-models.md).

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

Hezo is licensed under the [GNU General Public License v3.0 or later](./LICENSE.md).

X: [@hezo_ai](https://x.com/hezo_ai)