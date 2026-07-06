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

You unlock from the web app's gate screen. On a server you can also unlock a **single
startup** non-interactively by passing the `--master-key` flag / `HEZO_MASTER_KEY`
environment variable to that one invocation (see
[Deploying to the cloud](/docs/deployment/cloud)) — but don't persist the phrase to disk
to do it (see [Keep it off the server](#keep-it-off-the-server) below).

## Keep it off the server

The master key's protection comes entirely from where it *isn't*: it lives in memory only
and is **never written to disk**, so the encrypted data directory is useless to anyone who
copies it without the phrase. **Don't undo that by storing the key on the server yourself** —
not in an env file (`/etc/hezo/hezo.env`), the systemd unit, a shell profile, a same-host
secrets file, or a note in the repo. A copy of the phrase sitting next to the encrypted
vault means a stolen disk image, a leaked backup, or anyone who can read the box can decrypt
everything — exactly what encryption at rest is meant to prevent.

That Hezo comes up **locked** after every restart is the feature, not an inconvenience:
unlock it from the browser gate each time. If you genuinely must automate one launch, you
can pass `HEZO_MASTER_KEY` to that single invocation, but treat the phrase like a crypto
wallet seed — keep the only durable copy somewhere safe **off** the server.

The one exception is an in-app **update** restart: the process that supervises the update
hands the unlock key to the new process **in memory** — still never written to disk — so
installing an update doesn't ask for the phrase again. Every other restart (service
restart, reboot, crash) locks as described above. See
[Updating](/docs/deployment/self-hosting#updating).

## Your password vs. the master key

The master key and your password do two different jobs:

- The **master key** *unlocks the instance* — it turns encryption on and, once entered (or
  supplied via `HEZO_MASTER_KEY`), it's done for that run. It is **not** how you sign in.
- Your **admin password** is how you *sign in* to the web app. On first run, right after
  the master key, you set a password; from then on each browser session is authenticated
  with it. Your password (like the master key) never leaves your browser — Hezo stores only
  a verifier it can check a login against, never the password itself.

This split is what lets you run Hezo on a public network safely: access is gated by the
admin password on every request, while the master key stays purely about unlocking
encryption. You unlock the instance from the browser gate after each restart, and everyone
still has to sign in with the password to reach the app. See
[Secure remote access](/docs/deployment/secure-remote-access).

**Changing your password?** While signed in, go to **Settings → Admin password**, enter
your current password and the new one twice, and save. Your session stays signed in.

**Forgot your password?** Reset it with your master key: on the sign-in screen choose
**Forgot password? Use your master key**, enter the twelve words, and set a new one. The
master key is the ultimate authority, so it's also your password-recovery path.

> **Upgrading an existing instance?** Your admin account is given the default password
> `password` so you can sign in right away — **change it immediately** in
> **Settings → Admin password**, especially before exposing the instance to a network.

## What's encrypted

The master key protects all confidential data at rest, including:

- AI provider **API keys** and **subscription tokens**,
- **OAuth tokens** for connected accounts and SaaS integrations, and
- the per-project **SSH/signing keys** used for git (see
  [Container isolation](/docs/security/container-isolation)).

## Recovery

A forgotten **password** is easy to recover — reset it with your master key (above). A
password you still know can be changed any time in **Settings → Admin password**.

A lost **master key** is different: there is intentionally **no backdoor.** If you lose it,
the encrypted data can't be recovered — your only path forward is to reset the instance and
start over (`hezo --reset`, see [Backup & recovery](/docs/deployment/backup-and-recovery)).
Keep the phrase somewhere you trust.
