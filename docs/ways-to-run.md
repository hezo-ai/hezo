---
title: Ways to run Hezo
order: 2
section: Overview
---

# Ways to run Hezo

Hezo is open source, and there are two ways to run it. The difference is who
runs the box.

**Self-host it.** You install one binary on a machine you control and run it
yourself. Free, under the GNU General Public License v3.0. Start at
[Installation](/docs/getting-started/installation).

**Hezo Cloud.** We run an always-on instance for you at your own address, keep
it patched and backed up, and you never touch a server. Paid, after a free
trial. Start at [Hezo Cloud](/docs/cloud/overview).

## What differs

| | Self-hosted | Hezo Cloud |
|---|---|---|
| Who runs the machine | You | We do |
| Where it runs | Anywhere you like, including your own laptop | One region, in the EU |
| Its address | Whatever you point at it | `you.app.hezo.ai`, chosen once |
| Where agent containers run | Your own runtime, or a managed sandbox service - [your choice](/docs/containers/overview), switchable | A managed sandbox service, fixed |
| Updates | You take them when you want, or leave auto-update off | You take them when you want |
| Shell access to the box | Yours | None, so no `hezo` command line |
| Database and file storage | Embedded by default, or bring your own | Managed for you |
| Who holds the recovery phrase | You | You. We never hold it |
| What it costs | Nothing. You pay your model providers | A monthly or annual plan, plus your model providers. See [hezo.ai/pricing](https://hezo.ai/pricing) |

## Which one to pick

**Self-host** if you want the work on hardware you control, if your data cannot
leave your own infrastructure, if you want to run agents on a local model
through Ollama or LM Studio at no per-token cost, or if you simply enjoy
running things. You need a machine that stays on, and a few minutes to set up
HTTPS and backups.

**Hezo Cloud** if you would rather not run a server at all, if you want an
always-on instance without leaving a laptop open, or if keeping a box patched
is not how you want to spend your time.

## Next

- Self-hosting: [Installation](/docs/getting-started/installation), then
  [First-run setup](/docs/getting-started/first-run).
- Hezo Cloud: [Hezo Cloud](/docs/cloud/overview), then
  [Getting started on Hezo Cloud](/docs/cloud/getting-started).
