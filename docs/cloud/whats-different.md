---
title: What's different from self-hosting
order: 5.4
section: Hezo Cloud
---

# What's different from self-hosting

Most of these docs describe your instance as it is. This page is the short list
of what does not apply, and what replaces it.

## Which pages apply to you

| Section | On Hezo Cloud |
|---|---|
| [Concepts](/docs/concepts/projects-and-teams) | Yes, unchanged |
| [Chat & messaging apps](/docs/chat/overview) | Yes, unchanged |
| [Security](/docs/security/secret-protection) | Yes, unchanged |
| [AI models & connections](/docs/ai-models) | Yes, unchanged - you bring your own accounts |
| [MCP API reference](/docs/reference/mcp-api) | Yes, unchanged |
| [Containers](/docs/containers/overview) | Read it for how sandboxing works. The backend is fixed for you, so the parts about choosing or switching one do not apply |
| [Budgets & cost control](/docs/concepts/budgets-and-costs) | Yes, and your plan sets the container-hour allowance |
| [Your data & the database](/docs/concepts/your-data) | Read it for the data model. The storage choices in it are made for you |
| [Installation](/docs/getting-started/installation) | No - there is nothing to install. See [Getting started on Hezo Cloud](/docs/cloud/getting-started) |
| [Deployment](/docs/deployment/self-hosting), every page | No - we run the machine |
| [CLI reference](/docs/reference/cli) | No - you have no shell on the machine |

## No shell, so no command line

Everything the `hezo` command does is done for you or from the web app,
backups included.

**Your data is looked after for you.** The database is backed up daily with
point-in-time recovery, your files are versioned, and a lost machine is rebuilt
from a snapshot with no data loss.

**Taking a backup into your own hands is a self-hosted thing**, since it is the
`hezo` command that does it. If you want an archive you hold yourself, or to
roll your own instance back to Tuesday, run Hezo yourself. See
[Ways to run Hezo](/docs/ways-to-run).

## Where agent containers run

On a self-hosted instance you choose between your own container runtime and a
managed sandbox service, and you can switch whenever you like. On Hezo Cloud
that choice is made: agents run on a managed sandbox service, which is also why
agent code never runs on your instance's own machine.

The consequences for how agents are isolated are in
[Container isolation](/docs/security/container-isolation) and
[Data & security on Hezo Cloud](/docs/cloud/data-and-security).

## Updates

A new Hezo release shows up in your instance and **you take it when you want
it**, exactly as a self-hosted operator does. We do not update your instance
behind you.

New instances are built from a snapshot that tracks the current release, so
anyone signing up starts current.

## Signing in, and unlocking

These are two different things and it is worth keeping them apart.

**Signing in** is by emailed link. There is no password to set, change or
reset. Your dashboard signs you in to your instance without ever being able to
unlock it.

**Unlocking** is your twelve-word recovery phrase, entered at your instance.
Your instance comes back unlocked after an ordinary update. It comes back
**locked** after a restart it did not plan, and asks you for the phrase.

## Your address and where it runs

- **Your address is `you.app.hezo.ai`**, chosen once when you sign up and kept
  for the life of the account.
- **Your instance runs on its own machine, in Europe.**
- **What happens to your data when you leave** is covered in [Data & security
  on Hezo Cloud](/docs/cloud/data-and-security).
