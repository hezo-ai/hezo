---
title: Container isolation
order: 16
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

- your **host filesystem** (only the project's own workspace is available), or
- your **host processes or devices**.

Outbound network access is handled separately, through Hezo's egress proxy (below).

## Outbound traffic goes through the egress proxy

Hezo points the container's outbound traffic at its **egress proxy** using the standard
`HTTP(S)_PROXY` settings. That's what makes the
[secret protection](/docs/security/secret-protection) guarantee hold: your real secrets
are only ever materialised at the proxy — agents inside the container hold placeholders,
never the actual values — and the proxy enforces which hosts each secret may be sent to.
(Calls to your LLM provider are the one exception: they go direct, with the model
credentials injected into the run.)

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
and container isolation — a compromised agent is boxed in: it can't read your secrets
(they're only ever materialised at the proxy, behind host allow-lists), can't reach your
host, and can't escape its project. You get the upside of autonomous agents running real
code without betting your system on every line of it being safe.
