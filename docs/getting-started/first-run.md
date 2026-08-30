---
title: First-run setup
order: 4
section: Getting started
---

# First-run setup

The first time you open Hezo at **http://localhost:3100**, a short setup flow gets you
to a working instance: pick your language, create your master key, set an admin password,
and connect a model.

## 1. Pick your language

Hezo's web app runs in twelve languages, and this comes first on purpose - everything after
it is the product itself, and reading master-key instructions in a language you don't speak
is a bad way to start.

Hezo guesses from your browser, so the screen usually arrives already answered and you can
just continue. Alongside the language you pick a **date format** and a **currency format**;
each option shows you a real example rather than a pattern to decode. Picking a language
re-renders the picker itself right away, so you can read it back before continuing.

The choice applies to the whole instance and is saved when you continue, so a refresh
mid-setup won't lose it. You can change it later in **Settings -> Languages & formats**, and
a language button in the top right stays available throughout setup. See
[Languages & formats](/docs/concepts/languages-and-formats).

## 2. Create your master key

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

After a reboot, crash, or service restart, Hezo starts **locked**: agents can't run and
secrets can't be read until you provide the phrase again on the unlock screen. An in-app
update restart is the exception - the supervisor passes the unlock key to the new process
in memory. You can pass it to a single startup non-interactively with
`--master-key` / the `HEZO_MASTER_KEY` environment variable, but don't store the phrase on
the server (see [Deploying to the cloud](/docs/deployment/cloud) and
[Master key & encryption](/docs/security/master-key)).

## 3. Set an admin password

After the master key unlocks, you create an **admin password**. This is how you sign in
from here on - the master key unlocks the *instance*, your password signs *you* in. Your
password never leaves your browser.

You can change it later in **Settings → Users & access**. If you ever forget it, reset it
with your master key from the sign-in screen. See
[Master key & encryption](/docs/security/master-key).

To sign out, use **Log out** at the bottom of the **Settings** menu - it clears your
session and returns you to the admin-password sign-in screen. (The instance itself stays
unlocked; signing back in only needs your password.)

## 4. Connect a model

Agents need a model to run. Add at least one **AI provider**. You can either:

- **Paste an API key** (or connect a subscription where supported) for Anthropic (Claude),
  OpenAI (ChatGPT), Google (Gemini), xAI (Grok), DeepSeek, Z.ai, Kimi, or OpenRouter.
- **Point Hezo at your own machine** with Ollama or LM Studio - the server URL is the only
  field. Nothing is billed per token.

Don't have a key yet? The connect form walks you through creating one, with links to each
provider's key console (also listed in [AI model support](/docs/ai-models)).

You can add more than one provider and switch between them later, including giving an
individual agent its own model. See [AI model support](/docs/ai-models).
