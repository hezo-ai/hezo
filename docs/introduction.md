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

## Why "Hezo"?

The name is a play on *hézuò* (合作), the Mandarin word for "to collaborate" or
"cooperate" — which is what the whole platform is about: agents working together,
and working with you, to get real projects done.

## Secure by design

Agents run arbitrary code, so Hezo is built so that a misbehaving or compromised
agent can't hurt you. Three guarantees sit underneath everything:

- **Your secrets stay yours.** Agents never see real API keys or tokens — they use
  named placeholders, and Hezo's egress proxy swaps in the real value at request
  time, only for the hosts you've allowed. See
  [Secret protection & egress](/docs/security/secret-protection).
- **Everything sensitive is encrypted at rest** behind a master key that only you
  hold. See [Master key & encryption](/docs/security/master-key).
- **Every agent runs in its own container.** A compromised agent is confined to its
  project's sandbox — it can't reach your host or the rest of your system. See
  [Container isolation](/docs/security/container-isolation).

## What you can do with it

- **Spin up a team per project** from a template, or reuse an existing team's setup
  for a new project. See [Projects & teams](/docs/concepts/projects-and-teams).
- **Chat with the CEO in real time** to scope work, create projects, hire new agents, edit
  system prompts, and adjust settings — all from one conversation, with replies streaming
  back as it works. See [Roles & the CEO](/docs/concepts/roles-and-coordination).
- **Bring your own models.** Claude, ChatGPT, Gemini, DeepSeek, Z.ai, OpenRouter, and
  Kimi are all supported, and you can give any individual agent its own model. See
  [AI model support](/docs/ai-models).
- **Keep spend under control** with per-agent and per-project budgets and live cost
  reporting. See [Budgets & cost control](/docs/concepts/budgets-and-costs).
- **Set the rules per task** and let agents keep a running progress summary so work
  carries cleanly across runs. See [Tasks, rules & summaries](/docs/concepts/tasks).
- **Give your agents long-term memory.** Keep durable project documents — PRDs, specs,
  research — with full version history, and let the CEO remember your standing preferences
  across every conversation. See
  [Documents & long-term memory](/docs/concepts/documents-and-memory).
- **Collect and generate assets.** Upload mockups, images, and PDFs; let agents produce
  interactive HTML and SVG deliverables; and preview their work right in the app. See
  [Assets & previews](/docs/concepts/assets).
- **Connect it to your own tools** — Hezo even ships its own MCP server, so any
  MCP-capable agent can drive your teams and tasks. See
  [Hezo's MCP server](/docs/mcp/hezo-mcp-server).

## Where to next

- [Installation](/docs/getting-started/installation) — get Hezo running.
- [First-run setup](/docs/getting-started/first-run) — your master key and first model.
- [Your first project](/docs/getting-started/first-project) — from idea to a working team.
- [How Hezo works](/docs/concepts/how-hezo-works) — the architecture at a glance.
