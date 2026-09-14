---
title: Hezo Cloud
order: 5.1
section: Hezo Cloud
---

# Hezo Cloud

**Hezo Cloud is Hezo, run for you.** You get your own always-on instance at
your own address, with unlimited projects and unlimited agents, and you never
touch a server. It is the same software you would self-host, so every other
page in these docs still describes what you are using.

If you would rather run it yourself, that option is free and fully supported -
see [Ways to run Hezo](/docs/ways-to-run).

Plans and prices are on [hezo.ai/pricing](https://hezo.ai/pricing).

## What you get

- **Your own instance**, at `you.app.hezo.ai`. One per account. You choose the
  address once, when you sign up.
- **Unlimited projects and unlimited agents.** There are no seats and no
  per-agent charge. What a plan sets is how many containers can run at once and
  how many container-hours a month they may use. See
  [Plans, usage & billing](/docs/cloud/plans-and-billing).
- **A twelve-word recovery phrase that only you hold.** You choose it in your
  own browser the first time you open your instance.
- **Twelve languages**, for the dashboard, our mail and your instance alike.

## What we run for you

- **The machine**, and the operating system on it, patched.
- **HTTPS and the address**, with the certificate issued and renewed for you.
- **The database and your file storage**, managed, backed up daily with
  point-in-time recovery, and versioned. A lost machine is rebuilt from a
  snapshot with no data loss.
- **The sandboxes your agents work in.** Agent code never runs on your
  instance's own machine - it runs in a separate sandbox service. See
  [Data & security on Hezo Cloud](/docs/cloud/data-and-security).
- **New Hezo releases**, ready for you to take when you want them. We do not
  update your instance behind you.

## What you bring

- **Your own model accounts.** Hezo Cloud does not resell inference and does
  not mark it up. Connect Anthropic, OpenAI, Google, xAI, Kimi, DeepSeek, Z.ai
  or OpenRouter exactly as a self-hosted instance does, and that spend is
  billed to you by them. See [AI model support](/docs/ai-models).
- **Your recovery phrase.** We never hold it, and nobody here can recover it
  for you.
- **Anything your agents need to reach** - repositories, connectors, API
  credentials - which are stored encrypted and are never handed to an agent in
  the clear. See [Secret protection & egress](/docs/security/secret-protection).

## Where it runs

One region, in the European Union. There is no region choice today, and no
custom domain: every instance answers on a `app.hezo.ai` address.

## Next

- [Getting started on Hezo Cloud](/docs/cloud/getting-started) - signing up and
  opening your instance.
- [What's different from self-hosting](/docs/cloud/whats-different) - which
  pages in these docs apply to you.
- [Plans, usage & billing](/docs/cloud/plans-and-billing).
