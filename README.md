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
  · <!-- TODO(founder): point at the live docs site once published, e.g. https://hezo.ai/docs -->
  <a href="./docs/introduction.md">Docs</a>
  · <a href="https://hezo.ai">Website</a>
  · <a href="https://github.com/hezo-ai/hezo">GitHub</a>
  <!-- TODO(founder): add Discord / X links here once they exist. -->
</p>

> **Pre-launch.** You can build and run Hezo from source today (see [Quickstart](#quickstart)).
> One-line installers and prebuilt binaries land at launch. Stars and feedback are very welcome.

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

## How it works

1. **Create a project.** Describe the work to the CEO in plain language; it scopes the
   project and provisions a team for you.
2. **Assemble the team.** Start from a template, hire roles, edit their system prompts, and
   give any agent its own model.
3. **Approve and run.** Agents pick up tasks and work autonomously on a heartbeat. You set
   the rules, watch progress live, approve sensitive actions, and cap the spend.

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

- **Encrypted at rest.** API keys, tokens, and signing keys are encrypted (AES-256-GCM)
  with a master key that lives in memory only and is never written to disk — Hezo can't
  even unlock itself without you.
- **Sandboxed.** Every agent runs in a per-project Docker container with no host access and
  all traffic forced through the proxy. The blast radius of a bad run is one box.
- **Yours.** Self-hosted, your model accounts, your spend, your data.

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

## Features

**Security & control**
- Secret substitution at the egress proxy — placeholders in, real keys swapped in only for
  allowed hosts.
- Encrypted at rest (AES-256-GCM) behind one master key only you hold.
- Per-project Docker isolation, with all agent traffic forced through the proxy.
- Verified git commits, signed host-side with your project key.

**Orchestration**
- An org chart of roles — CEO, Coach, Captain, and workers — that coordinate.
- A task board with per-task rules and an agent-maintained progress summary.
- Heartbeat execution: agents wake on a schedule to pick up work, gated by budget.
- Multiple projects, each an independent team in its own isolated container.

**Models & cost**
- Bring your own providers; mix models freely, down to one per agent.
- Hard daily / weekly / monthly budget caps per agent and per project.

**Interface**
- A mobile-first web app — oversee, chat, and approve from any device.
- A built-in MCP server, so any MCP client can drive your teams and tasks.

## How Hezo compares

|  | Agents in terminal tabs | Hosted agent platforms | Agent frameworks / SDKs | **Hezo** |
|---|---|---|---|---|
| Runs on | Your machine, by hand | Someone else's cloud | Wherever you build it | **Hardware you own** |
| Your secrets | Live in your shell | Held by the vendor | You wire them up | **Never exposed to the agent** |
| Many agents | Tabs and willpower | Varies | You build it | **An org chart, built in** |
| Spend control | Watch the meter | Vendor billing | Do it yourself | **Hard budget caps** |
| You provide | Prompts, by hand | Vendor config | Code | **Goals and rules** |

## Hezo is not…

- **…a chatbot.** Agents have jobs, projects, and reporting lines.
- **…an agent framework or SDK.** It's the company *around* the agents, not a library to
  build one.
- **…a hosted SaaS.** You run it yourself, on your own hardware.
- **…a no-code workflow builder.** Agents reason and act; you set the goals and the rules.

## Quickstart

> Pre-launch: build from source for now. Prebuilt binaries and a one-line installer arrive
> at launch.

**Requirements:** [Bun](https://bun.sh/) v1.3.14+ and Docker (agents run in containers).

```sh
git clone https://github.com/hezo-ai/hezo.git
cd hezo
bun install
bun run dev
```

Open **http://localhost:3100** and follow the setup flow to create your master key and
connect a model. From there, see [Your first project](./docs/getting-started/first-project.md).

<!-- TODO(founder): once releases are live, document the binary install here:
     curl -fsSL https://hezo.ai/install.sh | sh   (macOS/Linux)
     irm https://hezo.ai/install.ps1 | iex        (Windows) -->

## Documentation

Full docs live in [`docs/`](./docs/introduction.md):

- [Introduction](./docs/introduction.md) · [How Hezo works](./docs/concepts/how-hezo-works.md)
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

**Do I need to host my own models?** No — you bring API keys or subscriptions for the
providers you want. Hezo runs the agents; the models stay with their providers.

**Can agents see my API keys?** No. Agents only ever use placeholders; the real value is
substituted at the network edge, and only for hosts you've allowed.

**Is my data sent anywhere?** Hezo is self-hosted. Your data stays in your instance; agents
reach your chosen model providers and any hosts you allow, and nothing else.

**Can I run multiple projects?** Yes — each gets its own team and its own isolated
container.

**How are agents kept from running up a huge bill?** Set daily, weekly, or monthly budgets
per agent and per project; agents pause when a window is exhausted and resume when it rolls
over.

## Development

Contributor setup, scripts, and the testing guide live in
[`.dev/DEVELOPING.md`](./.dev/DEVELOPING.md) and [`AGENTS.md`](./AGENTS.md).

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
