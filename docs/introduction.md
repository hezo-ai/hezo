---
title: Introduction
order: 1
section: Overview
---

# Introduction

**Hezo is a self-hosted platform for running teams of AI agents.** You install one
binary, open a web app, and stand up a whole organisation of agents - a CEO, a
Captain, engineers, designers, researchers, whatever the work needs - that plan and
execute real projects under your oversight. You own the machine, the model keys, the
spend, and the data.

Think of it as the company around the agents: org charts, projects, budgets,
approvals, and coordination, instead of twenty terminal tabs you babysit by hand.

> [!TIP]
> **Did you know?** The name *Hezo* is a play on *hézuò* (合作), the Mandarin
> word for "to collaborate" or "cooperate" - which is what the whole platform is
> about: agents working together, and working with you, to get real projects done.

## Secure by design

Agents run arbitrary code, so Hezo is built so that a misbehaving or compromised
agent can't hurt you. A few guarantees sit underneath everything:

- **Your secrets stay yours.** Agents never see real API keys or tokens - they use
  named placeholders, and Hezo's egress proxy swaps in the real value at request
  time, only for the hosts you've allowed. See
  [Secret protection & egress](/docs/security/secret-protection).
- **Everything sensitive is encrypted at rest** behind a master key that only you
  hold. See [Master key & encryption](/docs/security/master-key).
- **Each project's agents run in their own container.** A compromised agent is confined to its
  project's sandbox - it can't reach your host or the rest of your system. See
  [Container isolation](/docs/security/container-isolation), and
  [Containers](/docs/containers/overview) for where those containers run (your own Docker
  daemon or a managed service).
- **Agents work in real repos without holding the keys.** Git signing and SSH happen
  on the host, so commits land **verified** while the key never enters the sandbox. See
  [Git & verified commits](/docs/security/git-and-verified-commits).

## What you can do with it

- **Spin up a team per project** from a template, or reuse an existing team's setup
  for a new project. See [Projects & teams](/docs/concepts/projects-and-teams).
- **Structure the team to the work - and restructure it as the work changes.** Compose a
  team's roster, reporting lines, and roles, evolve them while a project runs, and carry a
  structure you've tuned forward to the next project. See
  [Team structure](/docs/concepts/team-structure).
- **Chat with the CEO in real time** to scope work, create projects, hire new agents, edit
  system prompts, and adjust settings - all from one conversation, with replies streaming
  back as it works. See [Roles & the CEO](/docs/concepts/roles-and-coordination).
- **Get teams that improve themselves.** Whenever a task is finished, the Coach reviews
  how it went and writes durable lessons back onto the agents, so they get better the more
  they ship - without you hand-tuning prompts. See
  [The Coach & self-improving teams](/docs/concepts/coach-and-self-improving-teams).
- **Bring your own models, each via a real agentic runtime.** Claude, ChatGPT, Gemini,
  Grok, DeepSeek, Z.ai, Kimi, and OpenRouter are all supported - Claude, ChatGPT, Gemini, and
  Grok through their own first-party command-line tooling, DeepSeek, Z.ai, and Kimi through
  Claude Code against their Anthropic-compatible endpoints (Kimi can alternatively run on
  Moonshot's own Kimi Code CLI), and OpenRouter through OpenCode -
  not a lowest-common-denominator wrapper. You can also run **entirely on your own hardware**
  with Ollama or LM Studio, at no per-token cost. You can give any individual agent its own
  model. See [AI model support](/docs/ai-models).
- **Put a hard ceiling on spend.** Per-agent and per-project budgets with live cost
  tracking *pause* runs when a limit is hit and *auto-resume* when the window rolls over -
  control without babysitting. See [Budgets & cost control](/docs/concepts/budgets-and-costs).
- **See where a project stands at a glance.** Every project has a **Progress** page the Captain
  keeps current: a high-level summary plus the tasks recently worked, filed and finished, each
  with a line explaining what it means for the project. See
  [Progress & project status](/docs/concepts/progress).
- **Steer by outcome, not just tasks.** Optionally set high-level **goals** and let the Captain
  re-check each one on a schedule (it writes a fresh progress estimate, health, and status). See
  [Goals](/docs/concepts/goals).
- **Set the rules per task** and let agents keep a running progress summary so work
  carries cleanly across runs. See [Tasks, rules & summaries](/docs/concepts/tasks).
- **Give your agents long-term memory - versioned and reversible.** Keep durable project
  documents, [skills](/docs/concepts/skills), and agent prompts, all with full revision
  history and one-click restore, and let the CEO remember your standing preferences. See
  [Documents & long-term memory](/docs/concepts/documents-and-memory).
- **Collect and generate assets.** Upload mockups, images, and PDFs; let agents produce
  interactive HTML and SVG deliverables; and preview their work right in the app. See
  [Assets & previews](/docs/concepts/assets).
- **Connect your tools, both ways.** Drive your teams and tasks from any MCP client via
  Hezo's [built-in MCP server](/docs/mcp/hezo-mcp-server), and give your agents the tools
  you already use by [connecting external services](/docs/mcp/connecting-mcp-servers) -
  hosted MCP servers or plain REST APIs.
- **Own your data.** Hezo carries an embedded database by default - no external service
  to run (or bring your own Postgres, and keep asset files in your own S3-compatible
  bucket) - so your work lives in storage you control, with safe, data-preserving
  upgrades. See [Your data & the database](/docs/concepts/your-data).
