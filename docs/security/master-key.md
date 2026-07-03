---
title: Master key & encryption
order: 19
section: Security
---

# The master key & encryption at rest

Everything sensitive Hezo holds — model API keys, OAuth tokens, signing keys, and other
secrets — is **encrypted at rest**. The key that protects it all is yours, and yours
alone: the **master key**.

## A twelve-word key only you hold

On first run, Hezo generates a **twelve-word master key** and shows it to you once. From
it, Hezo derives the key used to encrypt and decrypt your vault using strong,
authenticated encryption (AES-256-GCM).

- It is held **in memory only** while Hezo is running — **never written to disk.**
- Hezo cannot unlock itself. Even on a routine restart, the master key has to be
  provided again. This is deliberate: nobody who gets a copy of your data directory can
  read your secrets without the phrase.

Treat it like the seed phrase of a crypto wallet: **write it down, store it safely, and
don't lose it.**

## Locked and unlocked

Hezo has a simple gate around your secrets:

- **Unset** — first run, before you've created a master key.
- **Locked** — Hezo is running but the master key hasn't been provided yet. Secrets
  can't be read and agents can't run. This is the state after every restart.
- **Unlocked** — you've provided the correct phrase; Hezo can decrypt secrets and
  agents run normally.

You unlock from the web app's gate screen, or non-interactively with the `--master-key`
flag / `HEZO_MASTER_KEY` environment variable when running on a server (see
[Deploying to the cloud](/docs/deployment/cloud)).

## Your password vs. the master key

The master key and your password do two different jobs:

- The **master key** *unlocks the instance* — it turns encryption on and, once entered (or
  supplied via `HEZO_MASTER_KEY`), it's done for that run. It is **not** how you sign in.
- Your **admin password** is how you *sign in* to the web app. On first run, right after
  the master key, you set a password; from then on each browser session is authenticated
  with it. Your password (like the master key) never leaves your browser — Hezo stores only
  a verifier it can check a login against, never the password itself.

This split is what lets you run Hezo on a public network safely: set `HEZO_MASTER_KEY` on
the server so it unlocks automatically on every restart, and everyone still has to sign in
with the password to reach the app. See
[Secure remote access](/docs/deployment/secure-remote-access).

**Forgot your password?** Reset it with your master key: on the sign-in screen choose
**Forgot password? Use your master key**, enter the twelve words, and set a new one. The
master key is the ultimate authority, so it's also your password-recovery path.

> **Upgrading an existing instance?** Your admin account is given the default password
> `password` so you can sign in right away — **change it immediately**, especially before
> exposing the instance to a network.

## What's encrypted

The master key protects all confidential data at rest, including:

- AI provider **API keys** and **subscription tokens**,
- **OAuth tokens** for connected accounts and SaaS integrations, and
- the per-project **SSH/signing keys** used for git (see
  [Container isolation](/docs/security/container-isolation)).

## Recovery

A forgotten **password** is easy to recover — reset it with your master key (above).

A lost **master key** is different: there is intentionally **no backdoor.** If you lose it,
the encrypted data can't be recovered — your only path forward is to reset the instance and
start over (`hezo --reset`, see [Backup & recovery](/docs/deployment/backup-and-recovery)).
Keep the phrase somewhere you trust.
