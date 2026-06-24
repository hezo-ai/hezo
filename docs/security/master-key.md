---
title: Master key & encryption
order: 15
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

## What's encrypted

The master key protects all confidential data at rest, including:

- AI provider **API keys** and **subscription tokens**,
- **OAuth tokens** for connected accounts and SaaS integrations, and
- the per-project **SSH/signing keys** used for git (see
  [Container isolation](/docs/security/container-isolation)).

## Recovery

There is intentionally **no backdoor.** If you lose the master key, the encrypted data
can't be recovered — your only path forward is to reset the instance and start over
(`hezo --reset`, see [Backup & recovery](/docs/deployment/backup-and-recovery)). Keep
the phrase somewhere you trust.
