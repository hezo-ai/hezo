---
title: Hezo Cloud
order: 5.1
section: Hezo Cloud
---

# Hezo Cloud

**Hezo Cloud is Hezo, run for you.** You get your own always-on instance at
your own address, with unlimited projects, unlimited agents and AI inference
included, and you never touch a server. The rest of these docs describe your instance;
[What's different from self-hosting](/docs/cloud/whats-different) is the short
list of exceptions.

If you would rather run it yourself, that option is free and fully supported -
see [Ways to run Hezo](/docs/ways-to-run).

Plans and prices are on [hezo.ai/pricing](https://hezo.ai/pricing/).

## What you get

- **Your own instance**, at `you.app.hezo.ai`. One per account. You choose the
  address once, when you sign up.
- **Unlimited projects and unlimited agents.** There are no seats and no
  per-agent charge. What a plan sets is how many containers can run at once and
  how many container-hours a month they may use. See
  [Plans, usage & billing](/docs/cloud/plans-and-billing).
- **AI inference included, on the Base AI model.** Every plan comes with a
  model already connected, so your agents can start work the moment your
  instance is up. It has no token meter and no bill of its own: your plan's
  container-hours bound it, with a daily safety limit set well above what they
  can use. See [The Base AI model](/docs/cloud/whats-different#the-base-ai-model).
- **An instance that unlocks itself.** We keep its recovery phrase for you,
  encrypted, so it never asks for it, and you can download a copy from your
  dashboard.
- **Twelve languages**, for the dashboard, our mail and your instance alike.

## What we run for you

- **The machine**, and the operating system on it, patched.
- **HTTPS and the address**, with the certificate issued and renewed for you.
- **The database and your file storage**, managed. The database is backed up
  daily with point-in-time recovery, and a lost machine is rebuilt from a
  snapshot with no data loss. Uploaded files have no separate backup, so a file
  you delete cannot be brought back.
- **The sandboxes your agents work in.** Agent code never runs on your
  instance's own machine - it runs in a separate sandbox service. See
  [Data & security on Hezo Cloud](/docs/cloud/data-and-security).
- **New Hezo releases**, ready for you to take when you want them. We do not
  update your instance behind you.

## What you bring

- **Your own model accounts, if you want them.** Sign in with a Claude or
  ChatGPT subscription, paste an API key from Anthropic, OpenAI, Google, xAI,
  Kimi, DeepSeek, Z.ai or OpenRouter, or point Hezo at your own model server
  reachable over the internet. That spend is billed to you by them. See [AI model support](/docs/ai-models).
- **Anything your agents need to reach** - repositories, connectors, API
  credentials - stored encrypted, and referenced by agents as placeholders
  rather than real values. See
  [Secret protection & egress](/docs/security/secret-protection).

## Where it runs

On its own machine, in Europe. Your instance answers on its own
`you.app.hezo.ai` address.

## Next

- [Getting started on Hezo Cloud](/docs/cloud/getting-started) - signing up and
  opening your instance.
- [What's different from self-hosting](/docs/cloud/whats-different) - which
  pages in these docs apply to you.
- [Plans, usage & billing](/docs/cloud/plans-and-billing).
