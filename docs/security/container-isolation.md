---
title: Container isolation
order: 15
section: Security
---

# Container isolation

Agents execute real, often AI-generated code. Hezo runs that code where it can't hurt
you: **every project gets its own Docker container, and agents only ever run inside
it** — never on your host directly.

## A sandbox per project

Each project's container is a private workspace holding that project's code and tools.
Because the sandbox is per project, one project's agents can't see or touch another's
work — the blast radius of anything going wrong is contained to a single project.

From inside the container, agents **cannot** reach:

- your **host filesystem** (only the project's own workspace is available),
- your **host processes or devices**, or
- the **network**, except through Hezo's controlled exit (below).

## All network traffic is forced through the egress proxy

Agents don't get raw network access. Every outbound connection is routed through Hezo's
**egress proxy** — there's no path around it. That's what makes the
[secret protection](/docs/security/secret-protection) guarantee hold: an agent can't
open a side channel to leak data, because the proxy is the only way out.

## Keys never enter the container

The keys that matter most never sit inside the sandbox where agent code could read
them:

- **Your secrets** are referenced by placeholder and substituted *outside* the
  container, at the proxy.
- **Git signing and SSH keys** stay on the host. When an agent commits or pushes, the
  signing happens host-side on its behalf — the private key is never exposed to the
  agent. Commits land **verified**, signed by your project's key.

## What this gives you

Putting the three pillars together — placeholders + egress scoping, encryption at rest,
and container isolation — a compromised agent is boxed in on every side: it can't read
your secrets, can't reach your host, can't escape its project, and can't smuggle data
out. You get the upside of autonomous agents running real code without betting your
system on every line of it being safe.

## Next

- [Secret protection & egress](/docs/security/secret-protection)
- [Master key & encryption](/docs/security/master-key)
