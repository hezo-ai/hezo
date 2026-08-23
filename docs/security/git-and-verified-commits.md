---
title: Git & verified commits
order: 21
section: Security
---

# Git & verified commits

Hezo's agents do real work in real repositories - cloning, committing, and pushing. The
way that works is designed so the credentials that make it possible **never enter the
agent's sandbox**, and so the commits your agents make land as **Verified** on GitHub.

## One key per project

Each project has its **own [Ed25519](https://en.wikipedia.org/wiki/EdDSA) key**, used to
sign the project's git commits. The private key is
[encrypted at rest](/docs/security/master-key) and lives **on your Hezo instance** - it
is never written into the container where agent code runs, wherever that container is.

## Connect GitHub once

To give a project access to GitHub, you connect a GitHub account once from the project's
**Connections** page using GitHub's **device flow**: Hezo shows you a short code to copy,
then a link to open, and you enter the code there. There's no OAuth app to pre-register
and no redirect URL to configure. On connect, the project's public key is **automatically registered** on
your GitHub account as a *signing* key, so commits show the Verified badge. Subsequent
repositories reuse that connection, and the same connection is what authenticates clones,
fetches and pushes.

When you link or create a repository, Hezo records it right away and prepares the
checkout **in the background** - starting the project's workspace and cloning the
repository can take a few minutes the first time. The repository shows **"Setting up…"**
until it's ready; if setup fails (for example the workspace couldn't start), the error is
shown on the repository with a **Retry** button.

If you connect a repository that has **no commits yet**, Hezo seeds it with a minimal
`README.md` on its first run and pushes that as the initial commit - an empty repository
has no branch for a task to build on, so this makes it usable immediately. (Repositories
you create through Hezo already start with an initial commit, so this only applies to
pre-existing empty repositories you link.)

### Every linked repository is a working repository

A project can link more than one repository, and agents work in **all** of them - each is
cloned into the workspace and checked out on the task's own branch, with its own remote.
One of them is the **designated** repository (the default place a task's work goes, and the
directory an agent starts in), but that is a default, not a boundary: an agent can commit,
push, and open a pull request in any repository you have linked. Nothing about a run is
scoped to a single repository - the same project key and the same connected account serve
every one of them.

### Write access is checked, not assumed

Being able to *see* a repository on GitHub is not the same as being able to *push* to it -
a read-only collaborator, and anyone at all on a public repository, can read it. So when
you link a repository, Hezo asks GitHub whether the connected account can write to it, and
re-checks whenever it has the chance (setup, retry, re-clone, and each time you expand the
repository on the **Git** settings page).

If the answer is no, the repository is still linked - linking a repository purely so agents
can read its code is perfectly valid - but it is marked **"No write access"**, with a note
naming the connected account. Agents are told the same thing, so instead of pushing into a
rejection they will tell you that the change needs write access. To fix it, grant the
connected account write access to that repository on GitHub; the badge clears on the next
check.

Should a push be rejected anyway, it is no longer silent: the failure is written into the
run's log with the actual error from git, so you can see exactly which repository and
account were refused.

## Verified commits, signed on the host

When an agent commits, the **signing happens host-side on its behalf** - the agent asks
Hezo to sign, but never sees the key. Because the project's key is registered as a signing
key on GitHub, those commits arrive **signed and marked Verified**, so you can trust at a
glance that work attributed to your project genuinely came through your instance.

## Clone, fetch, and push over HTTPS

Git transport runs over **HTTPS** (`https://github.com/owner/repo.git`), authenticated by
the token from the GitHub account you connected.

**That token is never inside the container.** The remote carries a placeholder in place of
the credential, and Hezo's egress proxy swaps in the real value as each request leaves
for GitHub - the same mechanism that protects every other secret an agent uses. A request that
somehow avoided the proxy would carry the placeholder, which is not a valid credential, so
it fails rather than leaking anything.

HTTPS rather than SSH because it is the transport that works everywhere. A
[remote container service](/docs/containers/remote/overview) may carry only HTTPS out of
the sandbox - Daytona, for instance, blocks SSH on every port - and a transport that works
on your laptop but not in production is worse than one that works in both.

## Committed work is never lost

Agent runs are time-limited, and each task works in a disposable working copy of the
repository that does not outlive the task. So that committed work always survives - even if a run is
cut short or reaches its time limit mid-way - Hezo **pushes every commit to the remote the
moment it is made**. As soon as an agent commits, that commit is on the task's branch on
GitHub, so nothing an agent has committed is ever lost with the run.

Each task works on its own branch (`hezo/<task>`), which becomes its pull request, so these
automatic pushes are always a clean fast-forward and never collide with other work. Only
*uncommitted* changes are ever at risk, which is why agents are guided to commit early and
often. One thing to know: because Hezo pushes on every commit, a branch that runs CI on each
push will build more often than it would with a single end-of-run push - scope CI to pull
requests if that becomes noisy.

An automatic push never interrupts the agent's commit; the commit lands locally either way.
But if the push itself is rejected, that is reported rather than hidden - the agent sees the
error immediately, and the run's log carries it too, so a repository whose commits are not
reaching GitHub is visible without having to go looking for it.

### If a push is rejected

A rejected push is the one case where committed work exists in only one place, so Hezo does
three things rather than one.

- **The run is marked failed**, even if the agent otherwise finished cleanly. Work that never
  reached GitHub is not a completed run, and saying so is what puts it in front of you.
- **A recovery copy is kept.** Hezo packs the undelivered commits and copies them onto your
  instance, so the next agent to work on that task picks them up automatically - even if it
  runs in a different container, and even if the original one is long gone. The copy is
  dropped once the commits do reach GitHub, and is otherwise kept until you delete the
  project.
- **The container is held open** if the copy could not be made, so the machine holding the
  only version of your work is never recycled while it is the only version.

The project's Containers page shows when a project is in this state. The fix is almost always
the connected GitHub account's write access to that repository - once a later run pushes
successfully, everything clears on its own.

## Recovering a stuck repository

Occasionally a project's working copy of a repository gets into a state where Hezo's automatic
syncing can't move it forward on its own - most often when the local copy of the main branch has
uncommitted changes that stop it from fast-forwarding to the latest commit on GitHub. When that
happens the repository quietly stops keeping up with the remote.

For these cases, an **admin** can open the project's **Git** settings page and expand any
repository to see its live state: the current branch, whether the working copy has uncommitted
changes, how far ahead or behind GitHub it is, and which tasks currently have work in progress
against it. From there, three recovery actions are available:

- **Discard local changes** - throws away uncommitted changes in the project's copy and resets it
  to match GitHub. This is the fix for the stuck-sync case above. Work already committed and pushed
  to GitHub is never affected.
- **Prune worktrees** - clears out per-task working copies for closed (completed or cancelled) tasks,
  plus any leftover copies from runs that were interrupted. Working copies for tasks still in progress
  are left untouched. A closed task's working copy is normally removed automatically the moment the
  task closes; this button is the manual sweep for anything left behind. Committed work on their
  branches is preserved.
- **Re-clone** - the last resort: deletes the project's copy entirely and clones it fresh from GitHub.

These actions only ever affect the local working copy on your instance, never the repository on
GitHub, and they're deliberately **blocked while any agent is actively working** in the project so a
reset can't pull the rug out from under a running task.

This is the same posture described in [Container isolation](/docs/security/container-isolation):
the keys that matter most stay on the host, and a compromised agent can use them only
indirectly, for the operations Hezo performs on its behalf.
