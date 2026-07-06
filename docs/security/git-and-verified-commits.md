---
title: Git & verified commits
order: 21
section: Security
---

# Git & verified commits

Hezo's agents do real work in real repositories — cloning, committing, and pushing. The
way that works is designed so the credentials that make it possible **never enter the
agent's sandbox**, and so the commits your agents make land as **Verified** on GitHub.

## One key per project

Each project has its **own [Ed25519](https://en.wikipedia.org/wiki/EdDSA) key**, used for
two things: signing the project's git commits, and authenticating git transport over SSH.
The private key is [encrypted at rest](/docs/security/master-key) and lives **on the
host** — it is never written into the container where agent code runs.

## Connect GitHub once

To give a project access to GitHub, you connect a GitHub account once from the project's
**Connections** page using GitHub's **device flow**: Hezo shows you a short code, you
enter it on GitHub, and you're done — there's no OAuth app to pre-register and no redirect
URL to configure. On connect, the project's public key is **automatically registered** on
your GitHub account as both a *signing* key (so commits show the Verified badge) and an
*authentication* key (so SSH git operations work). Subsequent repositories reuse that
connection.

When you link or create a repository, Hezo records it right away and prepares the
checkout **in the background** — starting the project's workspace and cloning the
repository can take a few minutes the first time. The repository shows **"Setting up…"**
until it's ready; if setup fails (for example the workspace couldn't start), the error is
shown on the repository with a **Retry** button.

## Verified commits, signed on the host

When an agent commits, the **signing happens host-side on its behalf** — the agent asks
Hezo to sign, but never sees the key. Because the project's key is registered as a signing
key on GitHub, those commits arrive **signed and marked Verified**, so you can trust at a
glance that work attributed to your project genuinely came through your instance.

## Clone, fetch, and push over SSH

Git transport runs over **SSH** (`git@github.com:owner/repo.git`), authenticated by the
same per-project key. The container reaches it through a tightly-scoped, per-run bridge to
the host — so an agent can clone, fetch, and push during its run without the key ever
being present inside the sandbox.

## Committed work is never lost

Agent runs are time-limited, and each task works in a throwaway copy of the repository that
is discarded when the run ends. So that committed work always survives — even if a run is
cut short or reaches its time limit mid-way — Hezo **pushes every commit to the remote the
moment it is made**. As soon as an agent commits, that commit is on the task's branch on
GitHub, so nothing an agent has committed is ever lost with the run.

Each task works on its own branch (`hezo/<task>`), which becomes its pull request, so these
automatic pushes are always a clean fast-forward and never collide with other work. Only
*uncommitted* changes are ever at risk, which is why agents are guided to commit early and
often. One thing to know: because Hezo pushes on every commit, a branch that runs CI on each
push will build more often than it would with a single end-of-run push — scope CI to pull
requests if that becomes noisy.

This is the same posture described in [Container isolation](/docs/security/container-isolation):
the keys that matter most stay on the host, and a compromised agent can use them only
indirectly, for the operations Hezo performs on its behalf.
