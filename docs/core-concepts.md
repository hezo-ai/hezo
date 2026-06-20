---
title: Core concepts
order: 4
section: Concepts
---

# Core concepts

A short mental model for how Hezo is put together.

## Projects

A **project** is the primary unit you work with. Each project has its own stack,
configuration, and deployment target, but every project speaks the same Hezo
commands — so moving between them carries no context-switching cost.

## A single binary

Hezo is distributed as **one self-contained binary**. There's no runtime to
install, no daemon to babysit, and nothing to keep up to date beyond the binary
itself. Install it, put it on your `PATH`, and every command is available
everywhere.

## Your infrastructure

Hezo **orchestrates**; you **own the accounts**. Deployments land on your own
infrastructure and providers. Hezo coordinates the build, ship, and measurement
steps without taking custody of your hosting, domains, or data.

## The shipping loop

Every project moves through the same loop — **build → deploy → measure →
market** — and Hezo gives each stage a consistent command surface. You stay in
flow instead of stitching services together.

## Where to next

- [CLI usage](/docs/cli-commands/usage) — every command and flag.
- [Deployment](/docs/deployment) — shipping to production.
