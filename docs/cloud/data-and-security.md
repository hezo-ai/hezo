---
title: Data & security on Hezo Cloud
order: 5.5
section: Hezo Cloud
---

# Data & security on Hezo Cloud

Hezo Cloud runs agents that write and execute real code, on infrastructure we
operate rather than yours. This page covers what protects your work, what we
can and cannot see, and what happens to your data when you leave.

The product-wide guarantees are unchanged and are documented under
[Security](/docs/security/secret-protection). What follows is what hosting adds.

## Your recovery phrase, and the limit of what it proves

Your twelve-word recovery phrase is generated **in your own browser** and
posted straight to your instance. It never passes through our dashboard, and we
never store it.

**We cannot decrypt what that phrase protects, and nobody here can recover it
for you.** If you lose it, the data it protects is gone - there is deliberately
no backdoor.

That claim is narrower than it sounds. It means we cannot read what Hezo
encrypted under your phrase: your stored credentials and the rest of your
vault. **It is not a claim that your data is invisible to us.** We operate the
database your instance writes to, so as the operator we are technically able to
read rows in it, the way any hosting provider can. What is beyond us is the
encrypted material.

If you need a setup where the operator genuinely cannot reach any of it, that
is self-hosting, and it is free. See [Ways to run Hezo](/docs/ways-to-run).

## One instance, one machine

Your instance has a machine to itself - a full virtual machine, not a share of
one with other customers. Instances cannot reach each other: that is enforced
by a firewall outside the machine, which something running inside it cannot
switch off.

Only our gateway may reach your instance, and only on one port.

## Agent code does not run on your instance

Your instance runs Hezo. **The code your agents write and execute runs
somewhere else**, in a separate per-run sandbox. So a container an agent
breaks, floods or compromises does not take the machine holding your instance
with it.

## Your secrets reach an agent as placeholders

Unchanged from self-hosting, and the reason it matters more here. Agents
reference every credential by a **placeholder**. The real value is substituted
by the egress proxy inside **your own instance**, at request time, and only for
the hosts that secret is scoped to.

**One credential is the exception.** The key for the model provider an agent is
running against is placed in that agent's container in readable form, because
the agent's own tool authenticates to the provider directly rather than through
the proxy. A compromised sandbox therefore exposes the prompts and files in that
sandbox, and the provider key the run was using. Every other secret was never
there. See [Secret protection & egress](/docs/security/secret-protection).

When an agent runs on the Base AI model, that credential is a key to our model
service issued to your instance alone. It can only make model requests charged
to your instance, and we can replace it at any time.

## The Base AI model

When your agents use the [Base AI model](/docs/cloud/whats-different#the-base-ai-model),
what they send it - the conversation, including any files and tool results in
it - passes through our model service to a third-party model provider, which
processes it to write the reply. That provider stores the data it receives
outside the European Union. Our [privacy policy](https://hezo.ai/privacy/)
names it.

**Our model service does not keep what your agents send.** It keeps a record of
how much your instance used.

**If your work should not go to that provider,** connect a model of your own and
make it the default. The Base AI model is then used only by an agent you point
at it.

## How we see you use the app

When you are signed in to your instance, Hezo Cloud counts the pages you open and
the main buttons you click, such as creating a task or sending a chat message. A
page is counted by what kind of page it is, such as a task page, never by its
address, so the names of your projects, tasks and files are not part of it. A
click is counted by the name we gave the button, never by what is written on it.

**We also record your sessions in the app**, so we can see where it gets in your
way. A recording shows the layout of each page and where you moved and clicked.
All the text on the page is hidden in it, and so is everything you type. It does
keep the address of each page it covers, which can name a project, a task or a
file. Names can also reach it through the hidden labels and tooltips that some
buttons and links carry. Page views, clicks and recordings go to an analytics
service we run ourselves. Your browser runs that service's scripts only if they
match a fixed integrity hash, so a changed analytics server cannot run other
code in your app.

**Some screens are never recorded at all.** A recording shows a blank box in their
place: your recovery phrase, passwords, a newly created API key, the sign-in codes
used to connect an AI provider or another service, credentials you paste in,
images you attach or upload, your agents' run logs and container logs, and the
chat.

**To look into a problem with your account, we can turn on recordings that show
the page text, for your account only.** Typed text stays hidden, and the screens
above are still never recorded. It switches itself off on its own, after 14 days
unless we set a different end date, and every time it is turned on or off is kept
in our audit trail.

Recordings and the click data behind them are kept for 30 days, then deleted.

Self-hosted Hezo sends none of this.

## The support chat

When you open the support chat, from the dashboard or from your instance, it
tells our support team where you are, so you do not have to explain it. From
your instance that is the screen you are on, the short name of the project you
are in, your Hezo version, and your language, theme and screen size. From the
dashboard it is the page you are on and your instance's status, its current
setup step and its last error.

It never sends the text of your tasks or documents. The project's short name is
made from the name you gave the project; apart from that, nothing it sends is
text you typed outside the chat. Nothing is sent while the chat is closed. What
it sends is kept with your contact in the support chat, and replaced each time
you open the chat.

## Payment details

Your card never reaches us. Payment is handled entirely by Stripe, which is the
merchant of record - we see that you paid, not what you paid with.

## Leaving

**There is no data export at launch.** Neither shutting down nor deleting your
account offers you a download of your work.

**Deleting your account is immediate and permanent.** It removes your instance,
its database and every file you have stored, cancels your subscription, and
cannot be undone. We keep no backup we could restore for you afterwards.

**Two things are kept.** Your account record, including the email address it
was opened with, is marked deleted rather than removed, because our audit trail
names it and a record that vanishes takes the history of what happened with it.
The record of the instance itself - its address, its plan and its usage totals -
is kept alongside it and marked destroyed, for the same reason and because the
address is never reissued. Your billing records are kept for as long as the law
requires, and Stripe keeps its own record of your payments, which is theirs to
erase on request to them. If you want the retained address erased as well, write
to us and we will deal with it individually.

**Not paying is different, and destroys nothing.** A held or shut-down instance
keeps its database and files, and subscribing again brings it back. See
[Plans, usage & billing](/docs/cloud/plans-and-billing).
