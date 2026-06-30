---
title: First-run setup
order: 4
section: Getting started
---

# First-run setup

The first time you open Hezo at **http://localhost:3100**, a short setup flow gets you
to a working instance: create your master key and connect a model.

## 1. Create your master key

Hezo encrypts everything sensitive — model keys, OAuth tokens, signing keys — at rest.
The encryption key is derived from a **master key**: a twelve-word phrase generated
for you on first run.

- **Write it down and keep it somewhere safe.** It is shown once.
- It is held **in memory only** and never written to disk.
- If you lose it, there is no recovery — the only way forward is to reset and start
  fresh. See [Master key & encryption](/docs/security/master-key).

After every restart, Hezo starts **locked**: agents can't run and secrets can't be
read until you provide the phrase again on the unlock screen. You can also supply it
non-interactively with `--master-key` / the `HEZO_MASTER_KEY` environment variable —
useful for servers (see [Deploying to the cloud](/docs/deployment/cloud)).

Setting the master key also signs you in as the instance operator — the board account
you'll use to oversee teams, approve work, and chat with the CEO. There's no separate
account sign-up step.

## 2. Connect a model

Agents need a model to run. Add at least one **AI provider** — paste an API key (or
connect a subscription where supported) for Anthropic (Claude), OpenAI (ChatGPT),
Google (Gemini), DeepSeek, Z.ai, or Kimi.

You can add more than one provider and switch between them later, including giving an
individual agent its own model. See [AI model support](/docs/ai-models).
