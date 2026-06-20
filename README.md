<!-- TODO(founder): add a banner/hero image. Drop the asset in the repo (e.g. .github/assets/banner.png) or host it, then set the src below. -->
<p align="center">
  <!-- <img src=".github/assets/banner.png" alt="Hezo" width="640" /> -->
</p>

<h1 align="center">Hezo</h1>

<p align="center">
  <strong>Self-hosted, secure orchestration for teams of AI agents.</strong>
</p>

<p align="center">
  Run a whole company of AI agents on hardware you own — with their secrets, costs,<br/>
  and blast radius under your control. If a coding agent is a contractor,<br/>
  Hezo is the company that hires, secures, pays, and manages them.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a>
  · <!-- TODO(founder): point at the live docs site once published, e.g. https://hezo.ai/docs -->
  <a href="./docs/introduction.md">Docs</a>
  · <a href="https://github.com/hezo-ai/hezo">GitHub</a>
  · <a href="https://hezo.ai">Website</a>
  <!-- TODO(founder): add community links once they exist -->
  <!-- · <a href="#">Discord</a> -->
  <!-- · <a href="#">X / Twitter</a> -->
</p>

<p align="center">
  <!-- TODO(founder): add badges once available — license (no LICENSE file yet), latest release, Discord, CI. -->
</p>

> 🚧 **Pre-launch.** Hezo hasn't launched yet. You can build and run it from source
> today (see [Quickstart](#quickstart)); one-line binary installers and prebuilt
> releases land at launch. Stars and feedback are very welcome.

<!-- TODO(founder): add a short demo GIF or video here — it's the highest-converting part of the README. -->

## What is Hezo?

Hezo is a self-hosted server and web app that lets you **stand up teams of AI agents
and run them like an organisation** — a CEO, a Captain, engineers, designers,
researchers, whatever the work needs — with org charts, projects, budgets, approvals,
and coordination built in.

You manage **goals and projects**, not twenty terminal tabs. And because agents run
real, often AI-generated code, Hezo is **secure by design**: agents never see your real
secrets, everything sensitive is encrypted behind a key only you hold, and every agent
runs sandboxed in its own container. You own the machine, the model keys, the spend,
and the data.

## How it works in three steps

1. **Create a project.** Chat with the CEO in plain language; it scopes the work and
   provisions a project and a team for you.
2. **Assemble the team.** Start from a template, hire new roles, edit their system
   prompts, and give any agent its own model.
3. **Approve and run.** Agents pick up tasks and work autonomously on a heartbeat. You
   set the rules, watch progress live, approve sensitive actions, and cap the spend.

## Works with your models

Bring your own provider accounts — connect as many as you like, and give any individual
agent its own model.

| Provider | Models | Runtime | Auth |
|---|---|---|---|
| **Anthropic** | Claude | Claude Code | API key or subscription |
| **OpenAI** | ChatGPT / GPT | Codex | API key or subscription |
| **Google** | Gemini | Gemini CLI | API key or subscription |
| **Kimi** (Moonshot) | Kimi | Kimi | API key or subscription |
| **DeepSeek** | DeepSeek | Claude Code | API key |
| **Z.ai** | GLM | Claude Code | API key |
| **OpenRouter** | Many, via one key | OpenCode | API key |

## Hezo is for you if you want to…

- ✅ Run autonomous AI agents **on infrastructure you own**, not someone else's cloud.
- ✅ Let agents use real credentials **without ever exposing the secrets** to them.
- ✅ **Sandbox** untrusted, AI-generated code so a bad run can't touch your system.
- ✅ Coordinate **multiple agents and projects** toward real goals.
- ✅ Put a **hard ceiling on model spend** with per-agent and per-project budgets.
- ✅ Oversee and approve work **from your phone**.

## Features

| | |
|---|---|
| 🔌 **Bring your own model** | Claude, ChatGPT, Gemini, DeepSeek, Z.ai, OpenRouter, Kimi — API key or subscription |
| 🕵️ **Secret substitution** | Agents use placeholders; real keys are swapped in only for allowed hosts |
| 🔐 **Encrypted at rest** | One master key only you hold protects every secret |
| 📦 **Container isolation** | Every project runs in its own sandbox |
| 💰 **Budgets & cost control** | Daily/weekly/monthly caps per agent and per project |
| 🏢 **Org chart & roles** | CEO, Coach, Captain, and worker agents that coordinate |
| 🎫 **Task board + rules** | Per-task rules and a living progress summary |
| 🎚️ **Per-agent models** | Mix providers within one team |
| 🔗 **Built-in MCP server** | Drive your teams and tasks from any MCP client |
| ✅ **Verified git commits** | Signed with your project key, host-side |
| 🗂️ **Multiple projects** | Independent teams, isolated from one another |
| 📱 **Mobile-first UI** | Oversee everything from any device |

## Why Hezo is special

- **Agents never hold your secrets.** They reference credentials by name; Hezo's egress
  proxy substitutes the real value at request time, and only for the hosts you've
  scoped each secret to. A compromised agent can't exfiltrate what it never sees.
- **Your data is encrypted behind a key only you hold.** API keys, tokens, and signing
  keys are encrypted at rest. The master key lives in memory only and is never written
  to disk — Hezo can't even unlock itself.
- **Every agent is sandboxed.** Agents run in per-project Docker containers with no host
  access and all network traffic forced through the egress proxy. The blast radius of a
  bad run is one project's box.
- **You own everything.** Self-hosted, your model accounts, your spend, your data.

## Architecture

```
                 ┌──────────────────────────────────────────────────┐
   you ──▶ web ──│                   Hezo server                     │
                 │            (one self-contained binary)            │
                 │                                                   │
                 │   Web app · API + realtime · MCP server           │
                 │   Embedded database · Encrypted vault             │
                 │   Egress proxy · Git signing · Orchestration      │
                 └───────────────────────┬───────────────────────────┘
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

## What's under the hood

- **Projects & teams** — each project owns one team (Captain + workers); HQ hosts the
  instance-wide CEO and Coach.
- **Tasks** — a board with descriptions, per-task rules, and agent-maintained progress
  summaries.
- **Heartbeat execution** — agents wake on a schedule to pick up work, gated by budget.
- **Secrets & egress** — encrypted vault + placeholder substitution at a single
  controlled network exit.
- **Containers** — one isolated Docker workspace per project.
- **Budgets** — token-cost tracking with hard per-agent and per-project caps.
- **MCP** — a built-in MCP server, plus the ability to connect external MCP servers to
  your agents.

See the [documentation](./docs/introduction.md) for the full picture.

## What Hezo is **not**

- ❌ **Not a chatbot.** Agents have jobs, projects, and reporting lines.
- ❌ **Not an agent framework or SDK.** It's the company *around* the agents, not a
  library to build one.
- ❌ **Not a hosted SaaS.** You run it yourself, on your own hardware.
- ❌ **Not a no-code workflow builder.** Agents reason and act; you set goals and rules.

## Quickstart

> Pre-launch: build from source for now. Prebuilt binaries and the one-line installer
> arrive at launch.

**Requirements:** [Bun](https://bun.sh/) v1.3.14+ and Docker (agents run in containers).

```sh
git clone https://github.com/hezo-ai/hezo.git
cd hezo
bun install
bun run dev
```

Then open **http://localhost:3100** and follow the setup flow to create your master key
and connect a model.

<!-- TODO(founder): once releases are live, document the binary install here:
     curl -fsSL https://hezo.ai/install.sh | sh   (macOS/Linux)
     irm https://hezo.ai/install.ps1 | iex        (Windows) -->

For more, see [Installation](./docs/getting-started/installation.md) and
[First-run setup](./docs/getting-started/first-run.md).

## Documentation

Full docs live in [`docs/`](./docs/introduction.md) and render on the website
<!-- TODO(founder): link the live docs site once published, e.g. https://hezo.ai/docs -->:

- [Introduction](./docs/introduction.md) and [How Hezo works](./docs/concepts/how-hezo-works.md)
- Getting started: [Installation](./docs/getting-started/installation.md) ·
  [First-run setup](./docs/getting-started/first-run.md) ·
  [Your first project](./docs/getting-started/first-project.md)
- Security: [Secret protection](./docs/security/secret-protection.md) ·
  [Master key](./docs/security/master-key.md) ·
  [Container isolation](./docs/security/container-isolation.md)
- [AI model support](./docs/ai-models.md) · [Hezo's MCP server](./docs/mcp/hezo-mcp-server.md)
- Deployment: [Self-hosting](./docs/deployment/self-hosting.md) ·
  [Cloud](./docs/deployment/cloud.md) ·
  [Secure remote access](./docs/deployment/secure-remote-access.md)

## FAQ

**Do I need to host my own models?** No — you bring API keys (or subscriptions) for the
providers you want. Hezo runs the agents; the models stay with their providers.

**Can agents see my API keys?** No. Agents only ever use placeholders; the real value is
substituted at the network edge and only for hosts you've allowed.

**Is my data sent anywhere?** Hezo is self-hosted. Your data stays in your instance;
agents reach your chosen model providers (and any hosts you allow) and nothing else.

**Can I run multiple projects?** Yes — each gets its own team and its own isolated
container.

**How are agents kept from running up a huge bill?** Set daily/weekly/monthly budgets
per agent and per project; agents pause when a window is exhausted and resume when it
rolls over.

## Development

Contributor setup, scripts, and architecture notes are in
[`.dev/DEVELOPING.md`](./.dev/DEVELOPING.md) and [`AGENTS.md`](./AGENTS.md).

```sh
bun install
bun run dev        # start the server + web UI
bun run test       # run the test suite
```

## Roadmap

<!-- TODO(founder): add a ROADMAP.md and link it here. -->

## Community

<!-- TODO(founder): add Discord / X (Twitter) / Discussions links once they exist. -->
Questions and bug reports are welcome via
[GitHub Issues](https://github.com/hezo-ai/hezo/issues).

## License

<!-- TODO(founder): no LICENSE file exists in the repo yet. Choose a license, add a
     LICENSE file, and state it here (and add a badge above). -->
