---
title: Introduction
order: 1
section: Overview
---

# Introduction

**Hezo is a self-hosted platform for running teams of AI agents.** You install one
binary, open a web app, and stand up a whole organisation of agents — a CEO, a
Captain, engineers, designers, researchers, whatever the work needs — that plan and
execute real projects under your oversight. You own the machine, the model keys, the
spend, and the data.

Think of it as the company around the agents: org charts, projects, budgets,
approvals, and coordination, instead of twenty terminal tabs you babysit by hand.

> [!TIP]
> **Did you know?** The name *Hezo* is a play on *hézuò* (合作), the Mandarin
> word for "to collaborate" or "cooperate" — which is what the whole platform is
> about: agents working together, and working with you, to get real projects done.

## Secure by design

Agents run arbitrary code, so Hezo is built so that a misbehaving or compromised
agent can't hurt you. A few guarantees sit underneath everything:

- **Your secrets stay yours.** Agents never see real API keys or tokens — they use
  named placeholders, and Hezo's egress proxy swaps in the real value at request
  time, only for the hosts you've allowed. See
  [Secret protection & egress](/docs/security/secret-protection).
- **Everything sensitive is encrypted at rest** behind a master key that only you
  hold. See [Master key & encryption](/docs/security/master-key).
- **Every agent runs in its own container.** A compromised agent is confined to its
  project's sandbox — it can't reach your host or the rest of your system. See
  [Container isolation](/docs/security/container-isolation).
- **Agents work in real repos without holding the keys.** Git signing and SSH happen
  on the host, so commits land **verified** while the key never enters the sandbox. See
  [Git & verified commits](/docs/security/git-and-verified-commits).

## What you can do with it

- **Spin up a team per project** from a template, or reuse an existing team's setup
  for a new project. See [Projects & teams](/docs/concepts/projects-and-teams).
- **Chat with the CEO in real time** to scope work, create projects, hire new agents, edit
  system prompts, and adjust settings — all from one conversation, with replies streaming
  back as it works. See [Roles & the CEO](/docs/concepts/roles-and-coordination).
- **Get teams that improve themselves.** Whenever a ticket is finished, the Coach reviews
  how it went and writes durable lessons back onto the agents, so they get better the more
  they ship — without you hand-tuning prompts. See
  [The Coach & self-improving teams](/docs/concepts/coach-and-self-improving-teams).
- **Bring your own models, each via its native runtime.** Claude, ChatGPT, Gemini,
  DeepSeek, Z.ai, OpenRouter, and Kimi are all supported — each driven through its own
  first-party command-line tooling, not a lowest-common-denominator wrapper — and you can
  give any individual agent its own model. See [AI model support](/docs/ai-models).
- **Put a hard ceiling on spend.** Per-agent and per-project budgets with live cost
  tracking *pause* runs when a limit is hit and *auto-resume* when the window rolls over —
  control without babysitting. See [Budgets & cost control](/docs/concepts/budgets-and-costs).
- **Steer by outcome, not just tickets.** Set high-level **goals** and let the Captain re-check
  each one on a schedule — it writes a fresh progress estimate, health, and status — so you can see
  where a project stands without reading every ticket. See [Goals & progress](/docs/concepts/goals).
- **Set the rules per task** and let agents keep a running progress summary so work
  carries cleanly across runs. See [Tasks, rules & summaries](/docs/concepts/tasks).
- **Give your agents long-term memory — versioned and reversible.** Keep durable project
  documents, [skills](/docs/concepts/skills), and agent prompts, all with full revision
  history and one-click restore, and let the CEO remember your standing preferences. See
  [Documents & long-term memory](/docs/concepts/documents-and-memory).
- **Collect and generate assets.** Upload mockups, images, and PDFs; let agents produce
  interactive HTML and SVG deliverables; and preview their work right in the app. See
  [Assets & previews](/docs/concepts/assets).
- **Connect your tools, both ways.** Drive your teams and tasks from any MCP client via
  Hezo's [built-in MCP server](/docs/mcp/hezo-mcp-server), and give your agents the tools
  you already use by [connecting external MCP servers](/docs/mcp/connecting-mcp-servers).
- **Own your data.** Hezo carries an embedded database — no external service to run — so
  your work lives on hardware you control, with safe, data-preserving upgrades. See
  [Your data & the database](/docs/concepts/your-data).

## Meta-harness

Every major model now ships its own agentic command-line tool — Claude Code, Codex, the
Gemini CLI, and more. Each *harness* wraps a model in a loop that reads and writes files,
runs commands, and uses tools. They are genuinely good and genuinely different, so picking
one means inheriting all of its tradeoffs, and juggling several by hand means inconsistent
results.

**Hezo is a meta-harness — a harness around the harnesses.** It runs each model inside its
own first-party harness, so you keep that model's native tooling, then wraps a single,
uniform platform layer around all of them: the same tools, memory, completeness checks, and
security on every run, whichever model an agent happens to use. That's what lets you put a
cheaper model on routine work and a frontier model on the hard problems while trusting the
floor underneath stays the same. See [Meta-harness](/docs/concepts/meta-harness).
