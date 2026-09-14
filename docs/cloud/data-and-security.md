---
title: Data & security on Hezo Cloud
order: 5.5
section: Hezo Cloud
---

# Data & security on Hezo Cloud

Hezo Cloud runs agents that write and execute real code, on infrastructure we
operate rather than yours. This page says plainly what that means: what
protects your work, what we can and cannot see, and what happens to your data
when you leave.

The product-wide guarantees are unchanged and are documented under
[Security](/docs/security/secret-protection). What follows is what hosting adds.

## Your recovery phrase, and the limit of what it proves

Your twelve-word recovery phrase is generated **in your own browser** and
posted straight to your instance. It never passes through our dashboard, and we
never store it.

**We cannot decrypt what that phrase protects, and nobody here can recover it
for you.** If you lose it, the data it protects is gone - there is deliberately
no backdoor.

Be precise about the size of that claim, because it is easy to overstate. It
means we cannot read what Hezo encrypted under your phrase: your stored
credentials and the rest of your vault. **It is not a claim that your data is
invisible to us.** We operate the database your instance writes to, so as the
operator we are technically able to read rows in it, the way any hosting
provider can. What is beyond us is the encrypted material.

If you need a setup where the operator genuinely cannot reach any of it, that
is self-hosting, and it is free. See [Ways to run Hezo](/docs/ways-to-run).

## One instance, one machine

Your instance has a machine to itself - a full virtual machine, not a share of
one with other customers. Instances cannot reach each other: that is enforced
by a firewall outside the machine, which something running inside it cannot
switch off.

Only our gateway may reach your instance, and only on one port.

## Agent code does not run on your instance

This is the part worth understanding. Your instance runs Hezo. **The code your
agents write and execute runs somewhere else**, in a separate per-run sandbox.

So a container that an agent breaks, floods or gets compromised does not put it
on the machine holding your instance.

## Your secrets never enter an agent's container

Unchanged from self-hosting, and the reason it matters more here. Agents
reference every credential by a **placeholder**. The real value is substituted
by the egress proxy inside **your own instance**, at request time, and only for
the hosts that secret is scoped to.

A compromised sandbox therefore exposes the prompts and files in that sandbox.
It does not expose your provider keys, because they were never there. See
[Secret protection & egress](/docs/security/secret-protection).

## Payment details

Your card never reaches us. Payment is handled entirely by Stripe, which is the
merchant of record - we see that you paid, not what you paid with.

## Leaving

**There is no data export at launch.** Neither shutting down nor deleting your
account offers you a download of your work.

**Deleting your account is immediate and permanent.** It removes your instance,
its database and every file you have stored, cancels your subscription, and
cannot be undone. We keep no backup we could restore for you afterwards.

**One thing is kept, and it is worth knowing about.** Your account record,
including the email address it was opened with, is marked deleted rather than
removed, because our audit trail names it and a record that vanishes takes the
history of what happened with it. Nothing else about you survives, and Stripe
keeps its own record of your payments, which is theirs to erase on request to
them. If you want the retained address erased as well, write to us and we will
deal with it individually.

**Not paying is different, and destroys nothing.** A held or shut-down instance
keeps its database and files, and subscribing again brings it back. See
[Plans, usage & billing](/docs/cloud/plans-and-billing).
