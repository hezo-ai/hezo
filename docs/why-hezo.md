---
title: Why Hezo
order: 2
section: Overview
---

# Why Hezo

Every serious coding model now ships its own agentic command-line tool — Anthropic has
Claude Code, OpenAI has Codex, Google has the Gemini CLI, and there are more. Each of
these *harnesses* wraps a model in a loop that can read and write files, run commands,
and use tools. They are genuinely good, and they are genuinely different: each has its
own strengths, its own guardrails, and its own rough edges. Picking one means inheriting
all of its tradeoffs; juggling several by hand means re-learning each tool and getting
inconsistent results depending on which one you happened to use.

Hezo's answer is to sit one level up.

## Hezo is a meta-harness

Hezo runs each model inside its **own first-party harness** — Claude drives Claude Code,
GPT drives Codex, Gemini drives the Gemini CLI, and so on (see
[AI model support](/docs/ai-models) for the full list). You keep each model's native
agentic tooling instead of settling for a lowest-common-denominator wrapper. Then Hezo
wraps a **single, uniform platform layer** around all of them, so the harness an agent
happens to run on becomes an implementation detail rather than something you manage.

Working as a meta-harness around the individual coding harnesses is what lets Hezo
**even out the tradeoffs between them** — so you can get quality results across very
different models. Three things do the levelling:

- **A uniform completeness check on every run.** When an agent decides it's finished,
  Hezo independently judges whether the work is *actually* done before letting the run
  end — it won't let an agent stop on failing tests, quietly declare a problem "out of
  scope", or punt with "I'll leave that for later". This same discipline is applied on
  top of every harness that supports it, which matters most for models or tools that
  wouldn't hold that line on their own. (One harness, OpenCode, can't support this hook
  yet, so runs there rely on the model alone.)
- **The same capabilities and the same safety, whichever model you choose.** Every
  agent — regardless of its harness — gets the same built-in tools, the same
  [skills](/docs/concepts/skills), the same project memory and
  [documents](/docs/concepts/documents-and-memory), the same task board, the same
  [sandbox](/docs/security/container-isolation), and the same
  [secret protection](/docs/security/secret-protection). Switching a model, or running
  several at once, never changes what an agent can do or how safely it runs.
- **Rough edges smoothed over.** The per-tool differences — how a prompt is delivered,
  how a run is configured, how results come back — are normalised by Hezo, so behaviour
  stays consistent no matter which harness backs a given agent.

The practical payoff: you can put a cheaper model on routine work and a frontier model
on the hard problems (you can even [give each agent its own model](/docs/ai-models)) and
trust that the *floor* — the tooling, the guardrails, and the security — stays the same
underneath all of them.

## A modern agent platform, by design

There's broad agreement now on the patterns that make agents actually work in practice.
Hezo is built around them — and because it provides them at the platform layer, every
agent gets them no matter which underlying model or harness it runs on:

| Pattern | How Hezo provides it |
|---|---|
| **Planning & goals** | Work lives as [tasks](/docs/concepts/tasks) on a board, each with a description, optional rules, and a living progress summary; the Captain plans and breaks work down. |
| **Sub-agents** | A whole [team of agents](/docs/concepts/roles-and-coordination) — a CEO, a Captain, and worker roles — delegates focused work to one another, and each native harness can also spin up its own child agents. |
| **File-system access** | Every agent works inside its project's [container workspace](/docs/security/container-isolation), with durable [documents](/docs/concepts/documents-and-memory) and an [assets library](/docs/concepts/assets) alongside it. |
| **Good prompts** | Each role carries a tuned system prompt, layered on top of the first-party agent prompt its harness already brings — so agents stay aligned to your intent. |
| **Code interpreter / bash** | Each native CLI harness can run code and shell commands directly inside the sandbox. |
| **Skills** | A shared [skills](/docs/concepts/skills) catalog gives agents reusable know-how they read on demand, instead of bloating every prompt. |
| **Sandboxes, code execution & CLIs** | Each model runs through its own first-party CLI, and every one of them runs inside an isolated [Docker sandbox](/docs/security/container-isolation) with all outbound traffic forced through Hezo's egress proxy. |

In other words, Hezo doesn't ask you to choose between a model's native agentic tooling
and a consistent, safe, well-structured platform around it — you get both.

## Where to next

- [How Hezo works](/docs/concepts/how-hezo-works) — the architecture at a glance.
- [AI model support](/docs/ai-models) — the providers, their runtimes, and per-agent models.
- [Container isolation](/docs/security/container-isolation) — the per-project sandbox.
- [Secret protection & egress](/docs/security/secret-protection) — how your keys stay yours.
