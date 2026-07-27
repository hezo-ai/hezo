---
title: First-run setup
order: 4
section: Getting started
---

# First-run setup

The first time you open Hezo at **http://localhost:3100**, a short setup flow gets you
to a working instance: create your master key, set an admin password, and connect a model.

## 1. Create your master key

Hezo encrypts everything sensitive (model keys, OAuth tokens, signing keys) at rest.
The encryption key is derived from a **master key**: a twelve-word phrase generated
for you on first run.

- **Write it down and keep it somewhere safe** - a password manager is ideal. It is
  shown once. The words stay hidden until you reveal them with the eye toggle.
- **You confirm it by pasting it back** before setup continues, so you can't move on
  without the full phrase. Need a different one? Generate a new key first.
- It is held **in memory only** and never written to disk.
- If you lose it, there is no recovery - the only way forward is to reset and start
  fresh. See [Master key & encryption](/docs/security/master-key).

After every restart, Hezo starts **locked**: agents can't run and secrets can't be
read until you provide the phrase again on the unlock screen. This is by design - unlock
it from the browser each time. You can pass it to a single startup non-interactively with
`--master-key` / the `HEZO_MASTER_KEY` environment variable, but don't store the phrase on
the server (see [Deploying to the cloud](/docs/deployment/cloud) and
[Master key & encryption](/docs/security/master-key)).

## 2. Set an admin password

After the master key unlocks, you create an **admin password**. This is how you sign in
from here on - the master key unlocks the *instance*, your password signs *you* in. Your
password never leaves your browser.

You can change it later in **Settings → Admin password**. If you ever forget it, reset it
with your master key from the sign-in screen. See
[Master key & encryption](/docs/security/master-key).

To sign out, use **Log out** at the bottom of the **Settings** menu - it clears your
session and returns you to the admin-password sign-in screen. (The instance itself stays
unlocked; signing back in only needs your password.)

## 3. Connect a model

Agents need a model to run. Add at least one **AI provider** - paste an API key (or
connect a subscription where supported) for Anthropic (Claude), OpenAI (ChatGPT),
Google (Gemini), xAI (Grok), DeepSeek, Z.ai, or Kimi. Don't have a key yet? The connect form walks
you through creating one, with links to each provider's key console (also listed in
[AI model support](/docs/ai-models)).

You can add more than one provider and switch between them later, including giving an
individual agent its own model. See [AI model support](/docs/ai-models).
