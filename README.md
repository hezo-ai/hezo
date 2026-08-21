<p align="center">
  <img src="assets/logo.svg" alt="Hezo" width="96" height="96" />
</p>

<h1 align="center">Hezo</h1>

<div align="center">

[![Release](https://img.shields.io/github/v/release/hezo-ai/hezo?label=release&color=blue)](https://github.com/hezo-ai/hezo/releases/latest)
[![Last release](https://img.shields.io/github/release-date/hezo-ai/hezo?label=last%20release)](https://github.com/hezo-ai/hezo/releases)
[![CI](https://github.com/hezo-ai/hezo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hezo-ai/hezo/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/hezo-ai/hezo/badge.svg?branch=main)](https://coveralls.io/github/hezo-ai/hezo?branch=main)
[![License: GPL v3](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](./LICENSE.md)
[![Languages: 12](https://img.shields.io/badge/languages-12-brightgreen.svg)](./docs/concepts/languages-and-formats.md)

</div>

<p align="center">
  <strong>Run teams of AI agents like an organisation - self-hosted, sandboxed,
  with budget caps and your own model keys.</strong>
</p>

<p align="center">
  <sub>One binary. Your machine, your model keys, your data. Agents never see your real secrets.</sub>
</p>

<p align="center">
  <code>curl -fsSL https://hezo.ai/install.sh | sh</code>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a>
  · <a href="#features">Features</a>
  · <a href="#agents-never-hold-your-secrets">Security</a>
  · <a href="./docs/introduction.md">Docs</a>
  · <a href="https://hezo.ai">Website</a>
  · <a href="https://x.com/hezo_ai">X</a>
</p>

<p align="center">
  <sub>⭐ If this is useful to you, a star helps other people find it.</sub>
</p>

<table>
  <tr>
    <td width="52%" valign="middle" align="center">
      <img src="assets/readme/hero-story.gif" alt="A task moves from your one-line brief through the team to shipped" width="440" />
    </td>
    <td width="48%" valign="middle" align="center">
      <img src="assets/readme/org-chart.gif" alt="An org chart builds itself: you, the CEO, the Captain, then an Engineer on Claude, a Designer on GPT and an Analyst on Gemini" width="420" />
    </td>
  </tr>
</table>

## What is Hezo?

Hezo is a self-hosted server and web app for running **teams of AI agents like an
organisation**. You stand up a CEO, a Captain, engineers, designers, researchers -
whatever the work needs - with org charts, projects, budgets, and approvals built in. You
manage goals and projects, not twenty terminal tabs.

Because those agents run real, often AI-written code, Hezo is **secure by design**: agents
never see your real secrets, everything sensitive is encrypted behind a key only you hold,
and every project runs sandboxed in its own container.

<sub><em>Hezo</em> (say it <em>huh-zwo</em>) is a play on <em>hezuo</em> (合作), Mandarin for "to collaborate".</sub>

## Quickstart

Agents always run inside a container, so this machine needs a Docker-compatible runtime
(or point Hezo at a [managed sandbox service](./docs/containers/remote/overview.md) and it
needs none). Everything else is in the binary.

**1. Install.** One self-contained binary, nothing to compile.

```sh
curl -fsSL https://hezo.ai/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://hezo.ai/install.ps1 | iex
```

**2. Start the server.**

```sh
hezo
```

**3. Open http://localhost:3100.** Follow the
[first-run setup](./docs/getting-started/first-run.md) to create your master key and
connect a model, then build [your first project](./docs/getting-started/first-project.md).

<sub>Docker, Colima, Rancher Desktop, OrbStack and Lima all work, and Hezo finds the socket
itself (see [Container runtimes](./docs/deployment/container-runtimes.md)). Switch between
local and managed containers at any time from <b>Settings &gt; Containers</b>; see
[Containers](./docs/containers/overview.md). Prefer a manual download? Grab the binary from
[GitHub Releases](https://github.com/hezo-ai/hezo/releases/latest), with full per-platform
steps in [Installation](./docs/getting-started/installation.md).</sub>

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

> These buttons target VM providers because the default setup runs each project's agents
> on the host's own container-runtime socket, which needs a **real VM** - not a
> managed-container PaaS (Render, Railway, Cloud Run). Run the containers on a
> [managed sandbox service](./docs/containers/remote/overview.md) instead and the server
> needs no runtime at all, so a much smaller VPS will do. See
> [Deploying to the cloud](./docs/deployment/cloud.md).

## How it works

1. **Create a project and pick a team.** Launch a ready-made team from the
   [marketplace](./docs/concepts/marketplace.md) - App Team, Social Media Marketing or
   Investment Portfolio - start from a
   [template](./docs/concepts/projects-and-teams.md#team-templates), or ask the
   [CEO](./docs/concepts/roles-and-coordination.md) to assemble one for the work.
2. **Set the direction.** Specify the project plan, shape the
   [team's structure](./docs/concepts/team-structure.md), [hire or customize
   agents](./docs/concepts/hiring-and-agents.md), and give any agent
   [its own model](./docs/ai-models.md#give-an-agent-its-own-model).
3. **The team gets to work.** Agents pick up [tasks](./docs/concepts/tasks.md) and work
   autonomously, asking for your [approval](./docs/getting-started/first-project.md#4-stay-in-control)
   when needed. The [project dashboard](./docs/concepts/progress.md) tells you where things
   stand without your having to read the board.

<table>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="assets/readme/ceo-chat.gif" alt="A teammate asks the CEO for status in a chat channel and the CEO answers" width="430" />
      <br /><sub>Ask the CEO from Slack, Telegram or Discord</sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="assets/readme/approvals.gif" alt="The Captain proposes a hire and waits for your approval before acting" width="430" />
      <br /><sub>Nothing consequential happens without your approval</sub>
    </td>
  </tr>
</table>

## Features

- **Agents organised like a company.** A global [CEO and Coach](./docs/concepts/roles-and-coordination.md)
  above per-team Captains and workers, with [org charts](./docs/concepts/team-structure.md)
  you reshape while a project runs.
- **Tasks that run themselves.** A [task board](./docs/concepts/tasks.md) with nested
  sub-tasks, heartbeat wake-ups, approval gates, and long runs that resume on their own.
- **One platform layer over every model.** The [meta-harness](./docs/concepts/meta-harness.md)
  runs each model in its own first-party CLI, then levels the differences: the same tools,
  skills, memory and sandbox whichever you pick, plus a completeness check that will not let
  a run end on failing tests or an "out of scope" dodge.
- **Agents never hold your secrets.** Every credential is a
  [placeholder](./docs/security/secret-protection.md). The egress proxy swaps in the real
  value only for the hosts you allowed.
- **Your models, your spend.** [Bring your own provider accounts](./docs/ai-models.md), give
  any agent its own model, set [budget caps](./docs/concepts/budgets-and-costs.md), and see
  cost per run.
- **Container hours, not just tokens.** A ledger of how long every container was up, with a
  [monthly allowance](./docs/concepts/budgets-and-costs.md) that stops new containers once
  it is spent.
- **Sign in to a subscription from the UI.** [Guided sign-in](./docs/ai-models.md) runs
  inside a container, so an Anthropic or OpenAI plan works without pasting an API key.
- **Self-hosted, one binary.** Runs anywhere a Docker-compatible runtime does, or on a host
  with no runtime at all when containers live on a
  [managed service](./docs/containers/remote/overview.md). Configured by a
  [`.cjs` config file](./docs/deployment/configuration.md).

<details>
<summary><strong>Everything else, with links into the docs</strong></summary>

<br />

- **Structure the team to the work** - compose the roster, the [reporting lines, and what each role is](./docs/concepts/team-structure.md), change it while a project runs, and carry a structure you've tuned forward to the next one.
- **Teams &amp; projects** - [one team per project](./docs/concepts/projects-and-teams.md), launch a ready-made team from the [marketplace](./docs/concepts/marketplace.md) or start from a [template](./docs/concepts/projects-and-teams.md#team-templates), [hire and customize agents](./docs/concepts/hiring-and-agents.md), [snapshot a team](./docs/concepts/projects-and-teams.md#reusing-a-team-setup) to reuse, [export one](./docs/concepts/marketplace.md#exporting-your-team) to share.
- **Know where a project stands** - a [project dashboard](./docs/concepts/progress.md) leading with a summary the Captain keeps current on its own, with optional high-level [goals](./docs/concepts/goals.md) and scheduled re-checks layered on top.
- **Choose where containers run** - on [your own machine](./docs/containers/local-docker.md) or a [managed sandbox service](./docs/containers/remote/overview.md), [switchable either way](./docs/containers/overview.md#switching-at-any-time) at any time, with containers started on demand and a memory budget shared across every project.
- **Secure by design** - [secret placeholders](./docs/security/secret-protection.md), [encryption at rest](./docs/security/master-key.md), [admin password sign-in](./docs/security/master-key.md#your-password-vs-the-master-key), [sandboxed containers](./docs/security/container-isolation.md), [verified git commits](./docs/security/git-and-verified-commits.md), an [audit trail](./docs/security/activity-log.md).
- **Teams that improve themselves** - the [Coach](./docs/concepts/coach-and-self-improving-teams.md) writes durable learned rules back onto agents after each finished task.
- **Knowledge &amp; memory** - [documents](./docs/concepts/documents-and-memory.md), [skills](./docs/concepts/skills.md), [version history and restore](./docs/concepts/documents-and-memory.md#version-history), [long-term chat memory](./docs/concepts/documents-and-memory.md#long-term-chat-memory), [assets](./docs/concepts/assets.md), [full-text search](./docs/concepts/search.md).
- **Connect your tools, both ways** - drive Hezo from any MCP client via its [built-in MCP server](./docs/mcp/hezo-mcp-server.md), and give agents the services you already use with [connectors](./docs/mcp/connecting-mcp-servers.md) - hosted MCP servers or plain REST APIs - scoped to one project or shared across all of them.
- **Chat from anywhere** - run the CEO from [Telegram](./docs/chat/telegram.md), [Slack](./docs/chat/slack.md), and [Discord](./docs/chat/discord.md), as a [private assistant or a coworker](./docs/chat/overview.md#two-modes-assistant-and-coworker) in your team channels.
- **Your data, in your storage** - [embedded Postgres](./docs/concepts/your-data.md), optional [hosted Postgres](./docs/deployment/configuration.md), local or [S3-compatible](./docs/deployment/configuration.md#storing-assets-in-s3-compatible-object-storage) [asset storage](./docs/concepts/assets.md#where-asset-files-live), data-preserving upgrades.
- **Speaks your language** - the web app runs in [12 languages](./docs/concepts/languages-and-formats.md), picked from your browser on first run; [date and currency formats](./docs/concepts/languages-and-formats.md#date-and-currency-formats) are chosen independently.
- **Easy to run** - [one-click cloud-init](./docs/deployment/one-click.md), [secure remote access](./docs/deployment/secure-remote-access.md), [safe-rollback backups](./docs/deployment/backup-and-recovery.md), [in-app self-update](./docs/deployment/self-hosting.md#updating), a mobile-first web app.

</details>

<table>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="assets/readme/coach-loop.gif" alt="A task ships, the Coach reviews it and writes a durable rule back onto the agent" width="430" />
      <br /><sub>The Coach turns every finished task into a durable rule</sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="assets/readme/skills.gif" alt="Skills land in the library one by one, scoped per project or globally" width="430" />
      <br /><sub>Skills the whole team can use, per project or globally</sub>
    </td>
  </tr>
</table>

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

<p align="center">
  <img src="assets/readme/secret-flow.gif" alt="A placeholder leaves the agent container, the proxy checks the allowlist and substitutes the real key, and anything else is blocked" width="470" />
</p>

It's all **[yours](./docs/deployment/self-hosting.md)**: self-hosted, your model accounts,
your spend, your data.

## Works with your models

Bring your own provider accounts - connect as many as you like, and give any individual
agent [its own model](./docs/ai-models.md#give-an-agent-its-own-model). Each provider is
driven through its **native command-line runtime** inside the container, so you get each
model's first-party agentic tooling, not a lowest-common-denominator wrapper - and Hezo's
[meta-harness](./docs/concepts/meta-harness.md) levels the differences between them, so the
tooling, guardrails and security stay the same underneath whichever model you pick.

| Provider | Models | Runtime | Auth |
|---|---|---|---|
| **Anthropic** | Claude | Claude Code | API key or subscription |
| **OpenAI** | ChatGPT / GPT | Codex | API key or subscription |
| **Google** | Gemini | Antigravity | API key |
| **xAI** | Grok | Grok Build | API key |
| **Kimi** (Moonshot) | Kimi | Claude Code or Kimi Code | API key |
| **DeepSeek** | DeepSeek | Claude Code | API key |
| **Z.ai** | GLM | Claude Code | API key |
| **OpenRouter** | Many, via one account | OpenCode | API key |
| **Ollama** | Whatever you run locally | Claude Code | Server URL (key optional) |
| **LM Studio** | Whatever you run locally | Claude Code | Server URL (key optional) |

Where the Runtime column lists more than one, that credential chooses which CLI it runs on;
the first is the default, so adding a key without touching the setting just works. You can
change it later, or rotate the stored key in place, without re-adding the connection.

Ollama and LM Studio run agents **entirely on your own hardware** at no per-token cost -
point Hezo at your server URL and leave the key blank.

Full details (subscriptions vs. API keys, mixing providers, per-agent overrides) in
[AI model support](./docs/ai-models.md).

<p align="center">
  <img src="assets/readme/budget.gif" alt="Spend fills toward a monthly cap, with the projection and cost per run" width="430" />
</p>

## Development

Contributor setup, scripts, and the testing guide live in
[`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md).
You'll need [Bun](https://bun.sh/) v1.3.14+ and a Docker-compatible runtime.

```sh
git clone https://github.com/hezo-ai/hezo.git
cd hezo
bun install
bun run dev        # server + web UI on http://localhost:3100
bun run test       # the full test suite
```

## Community & license

⭐ **If Hezo is useful to you, a star helps other people find it.** It is the main way a
self-hosted project gets discovered, and it costs you one click.

Questions and bug reports are welcome via
[GitHub Issues](https://github.com/hezo-ai/hezo/issues).

Copyright (C) 2026 [Ramesh Nair](https://hiddentao.com).

Hezo is licensed under the [GNU General Public License v3.0 or later](./LICENSE.md).

X: [@hezo_ai](https://x.com/hezo_ai)
