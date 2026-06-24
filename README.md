<p align="center">
  <img src="assets/logo.svg" alt="Hezo" width="96" height="96" />
</p>

<h1 align="center">Hezo</h1>

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

<!-- TODO(founder): a 15–20s demo GIF here is the single highest-converting thing you can add.
     Record the CEO chat → a team spins up → a task runs live, and drop it at .github/assets/demo.gif. -->

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

```
                 ┌──────────────────────────────────────────────────┐
   you ──▶ web ──│                   Hezo server                     │
                 │            (one self-contained binary)            │
                 │                                                   │
                 │   Web app · API + realtime · MCP server           │
                 │   Embedded database · Encrypted vault             │
                 │   Egress proxy · Git signing · Orchestration      │
                 └───────────────────────┬──────────────────────────┘
                            provisions &  │  manages
                 ┌─────────────────────┐  │  ┌─────────────────────┐
                 │  Project A (Docker) │◀─┴─▶│  Project N (Docker) │
                 │   agents + tools    │     │   agents + tools    │
                 └──────────┬──────────┘     └──────────┬──────────┘
                            │                            │
                            └──────▶ egress proxy ◀──────┘
                                secrets substituted,
                                 allowed hosts only
                                        │
                                        ▼
                             your models & the internet
```

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

Every feature below links to its documentation.

### Orchestration & coordination

- **[An org chart of roles](./docs/concepts/roles-and-coordination.md)** — an instance-wide
  CEO and Coach in HQ, plus a Captain and worker agents on each team, that coordinate like
  a company.
- **[Real-time CEO chat](./docs/concepts/roles-and-coordination.md#chatting-with-the-ceo)** —
  one always-on conversation to scope projects, check status across every team, hire,
  retire, and change settings, with replies streaming back live.
- **[A Coach that makes teams improve every ship](./docs/concepts/roles-and-coordination.md#the-coach)** —
  it reviews each completed ticket and writes durable *learned rules* back onto the agents,
  so the same mistake doesn't happen twice — no prompt-tuning by hand.
- **[A task board with rules & progress summaries](./docs/concepts/tasks.md)** — each task
  carries a description, optional per-task rules enforced on every run, and an
  agent-maintained progress summary so work hands off cleanly across runs.
- **[Heartbeat execution](./docs/getting-started/first-project.md#3-watch-the-team-work)** —
  agents wake on a schedule to pick up work and keep moving without you driving each step.
- **[Approvals for sensitive actions](./docs/getting-started/first-project.md#4-stay-in-control)** —
  consequential changes (hiring an agent, pasting a credential, and the like) surface as
  approvals you confirm.
- **[Multiple projects, one team each](./docs/concepts/projects-and-teams.md)** — every
  project owns exactly one team, with its own roster, tasks, budget, and isolated
  container; nothing leaks between them.

### Team building

- **[Team templates](./docs/concepts/projects-and-teams.md#team-templates)** — start from a
  minimal **Blank** team (just a Captain) or a full **Software development** roster
  (architect, product lead, engineers, QA, security, design, DevOps, marketing, research).
- **[Save & reuse a team setup](./docs/concepts/projects-and-teams.md#reusing-a-team-setup)** —
  save a tuned team as a template, or start a new project directly from an existing team's
  roster.
- **[Hire, retire & customize agents](./docs/concepts/hiring-and-agents.md)** — add roles,
  edit any agent's system prompt (changes take effect next run), retire and reinstate
  roles, and tune each agent's heartbeat, budget, and code access.
- **[Per-agent model override](./docs/ai-models.md#give-an-agent-its-own-model)** — run one
  agent on a frontier model for hard reasoning while the rest run on something cheaper;
  mixing providers within a team is fully supported.
- **[Attach a project plan](./docs/concepts/projects-and-teams.md#the-project-plan-document)** —
  hand the team a fuller brief (goals, scope, constraints) that the Captain or Product Lead
  turns into the plan or PRD.

### Security & control

- **[Secret substitution at the egress proxy](./docs/security/secret-protection.md)** —
  placeholders in, real keys swapped in only for allowed hosts.
- **[Encrypted at rest](./docs/security/master-key.md)** (AES-256-GCM) behind one
  twelve-word master key only you hold.
- **[Per-project Docker isolation](./docs/security/container-isolation.md)**, with all agent
  traffic forced through the proxy.
- **[Verified git commits](./docs/security/container-isolation.md#keys-never-enter-the-container)**,
  signed host-side with your project key — the key never enters the container.
- **[Activity log & audit trail](./docs/security/activity-log.md)** — an append-only,
  attributed record of every action and every secret use, per project and instance-wide.

### Knowledge & deliverables

- **[Documents & long-term memory](./docs/concepts/documents-and-memory.md)** — durable
  markdown project docs (PRDs, specs, plans, research) that agents and you read and write,
  kept out of the source repo.
- **[Version history & one-click restore](./docs/concepts/documents-and-memory.md#version-history)** —
  every document edit is versioned, so the history doubles as an audit trail you can roll
  back.
- **[Chatbox memory](./docs/concepts/documents-and-memory.md#chatbox-memory)** — the CEO
  remembers your standing preferences across every conversation, so you don't repeat
  yourself.
- **[Assets library](./docs/concepts/assets.md)** — upload mockups, images, and PDFs, and
  let agents produce interactive **HTML** and **SVG** deliverables referenced from any
  task.
- **[Sandboxed HTML previews](./docs/concepts/assets.md#html-previews)** — click through an
  agent's mockup or dashboard live in the app, isolated from your data.

### Models & cost

- **[Bring your own providers](./docs/ai-models.md)** — connect Claude, ChatGPT, Gemini,
  Kimi, DeepSeek, Z.ai, or OpenRouter; mix models freely, down to one per agent.
- **[Hard budget caps](./docs/concepts/budgets-and-costs.md)** — daily, weekly, and monthly
  limits per agent and per project; runs pause when a window is exhausted and resume when
  it rolls over.
- **[Cost tracking](./docs/concepts/budgets-and-costs.md#cost-tracking)** — every run's cost
  is recorded and rolled up per agent and per project from the budget view.

### Integrate & extend

- **[A built-in MCP server](./docs/mcp/hezo-mcp-server.md)** — drive your teams and tasks
  from any MCP client (Claude Code, Cursor, Claude Desktop, your own scripts) with a
  team-scoped API key.
- **[Connect external MCP servers](./docs/mcp/connecting-mcp-servers.md)** — give Hezo's own
  agents the tools you already use (web search, trackers, a CMS), scoped per instance, team,
  or project.
- **[Connected agents](./docs/mcp/hezo-mcp-server.md#connecting-as-a-connected-agent-instance-wide)** —
  let an external agent self-register for instance-wide access, gated behind admin approval.
- **A mobile-first web app** — oversee, chat, and approve from any device.

### Run it your way

- **[A single self-contained binary](./docs/getting-started/installation.md)** — no runtime,
  toolchain, or external database to install; Docker is the only prerequisite.
- **[Self-host anywhere Docker runs](./docs/deployment/self-hosting.md)** — your laptop, a
  home server, or a cloud VPS, with everything in one data directory.
- **[Deploy to the cloud](./docs/deployment/cloud.md)** — run always-on and unlock
  unattended via `HEZO_MASTER_KEY`.
- **[Secure remote access](./docs/deployment/secure-remote-access.md)** — reach a hosted
  instance over Tailscale/WireGuard, a Cloudflare Tunnel, or an SSH tunnel, without
  exposing the port.
- **[Backup & safe rollback](./docs/deployment/backup-and-recovery.md)** — back up one
  directory; upgrades snapshot first, so they roll back cleanly.
- **[Configuration & CLI](./docs/deployment/configuration.md)** — every setting as a flag or
  environment variable; see the [CLI reference](./docs/reference/cli.md).

## How Hezo compares

|  | Agents in terminal tabs | Hosted agent platforms | Agent frameworks / SDKs | **Hezo** |
|---|---|---|---|---|
| Runs on | Your machine, by hand | Someone else's cloud | Wherever you build it | **Hardware you own** |
| Your secrets | Live in your shell | Held by the vendor | You wire them up | **Never exposed to the agent** |
| Many agents | Tabs and willpower | Varies | You build it | **An org chart, built in** |
| Spend control | Watch the meter | Vendor billing | Do it yourself | **Hard budget caps** |
| You provide | Prompts, by hand | Vendor config | Code | **Goals and rules** |

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

## Documentation

Full docs live in [`docs/`](./docs/introduction.md) and are rendered at
[hezo.ai/docs](https://hezo.ai/docs).

**Overview**
- [Introduction](./docs/introduction.md)
- [How Hezo works](./docs/concepts/how-hezo-works.md)

**Getting started**
- [Installation](./docs/getting-started/installation.md)
- [First-run setup](./docs/getting-started/first-run.md)
- [Your first project](./docs/getting-started/first-project.md)

**Concepts**
- [Projects & teams](./docs/concepts/projects-and-teams.md)
- [Roles & the CEO](./docs/concepts/roles-and-coordination.md)
- [Tasks, rules & summaries](./docs/concepts/tasks.md)
- [Documents & long-term memory](./docs/concepts/documents-and-memory.md)
- [Assets & previews](./docs/concepts/assets.md)
- [Hiring & customizing agents](./docs/concepts/hiring-and-agents.md)
- [Budgets & cost control](./docs/concepts/budgets-and-costs.md)

**Security**
- [Secret protection & egress](./docs/security/secret-protection.md)
- [Master key & encryption](./docs/security/master-key.md)
- [Container isolation](./docs/security/container-isolation.md)
- [Activity log & audit trail](./docs/security/activity-log.md)

**AI models & MCP**
- [AI model support](./docs/ai-models.md)
- [Hezo's MCP server](./docs/mcp/hezo-mcp-server.md)
- [Connecting MCP servers](./docs/mcp/connecting-mcp-servers.md)

**Deployment**
- [Self-hosting](./docs/deployment/self-hosting.md)
- [Deploying to the cloud](./docs/deployment/cloud.md)
- [Secure remote access](./docs/deployment/secure-remote-access.md)
- [Backup & recovery](./docs/deployment/backup-and-recovery.md)
- [Configuration reference](./docs/deployment/configuration.md)

**Reference**
- [CLI reference](./docs/reference/cli.md)

## FAQ

**Do I need to host my own models?** No — you bring API keys or subscriptions for the
providers you want. Hezo runs the agents; the models stay with their providers. See
[AI model support](./docs/ai-models.md).

**Can agents see my API keys?** No. Agents only ever use placeholders; the real value is
substituted at the network edge, and only for hosts you've allowed. See
[Secret protection & egress](./docs/security/secret-protection.md).

**Is my data sent anywhere?** Hezo is [self-hosted](./docs/deployment/self-hosting.md). Your
data stays in your instance; agents reach your chosen model providers and any hosts you
allow, and nothing else.

**Can I run multiple projects?** Yes — each gets its own
[team](./docs/concepts/projects-and-teams.md) and its own
[isolated container](./docs/security/container-isolation.md).

**How are agents kept from running up a huge bill?** Set daily, weekly, or monthly
[budgets](./docs/concepts/budgets-and-costs.md) per agent and per project; agents pause when
a window is exhausted and resume when it rolls over.

**Can other tools drive Hezo?** Yes — Hezo ships a [built-in MCP server](./docs/mcp/hezo-mcp-server.md),
so any MCP client can manage your teams and tasks, and your agents can use
[external MCP servers](./docs/mcp/connecting-mcp-servers.md) too.

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
