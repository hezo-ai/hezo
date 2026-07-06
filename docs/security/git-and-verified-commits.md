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

## Recovering a stuck repository

Occasionally a project's working copy of a repository gets into a state where Hezo's automatic
syncing can't move it forward on its own — most often when the local copy of the main branch has
uncommitted changes that stop it from fast-forwarding to the latest commit on GitHub. When that
happens the repository quietly stops keeping up with the remote.

For these cases, an **admin** can open the project's **Git** settings page and expand any
repository to see its live state: the current branch, whether the working copy has uncommitted
changes, how far ahead or behind GitHub it is, and which tasks currently have work in progress
against it. From there, three recovery actions are available:

- **Discard local changes** — throws away uncommitted changes in the project's copy and resets it
  to match GitHub. This is the fix for the stuck-sync case above. Work already committed and pushed
  to GitHub is never affected.
- **Prune worktrees** — clears out leftover per-task working copies from runs that were interrupted.
  Committed work on their branches is preserved.
- **Re-clone** — the last resort: deletes the project's copy entirely and clones it fresh from GitHub.

These actions only ever affect the local working copy on your instance, never the repository on
GitHub, and they're deliberately **blocked while any agent is actively working** in the project so a
reset can't pull the rug out from under a running task.

This is the same posture described in [Container isolation](/docs/security/container-isolation):
the keys that matter most stay on the host, and a compromised agent can use them only
indirectly, for the operations Hezo performs on its behalf.
