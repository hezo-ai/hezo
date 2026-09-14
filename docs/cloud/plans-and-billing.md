---
title: Plans, usage & billing
order: 5.3
section: Hezo Cloud
---

# Plans, usage & billing

Hezo Cloud is priced on how much your agents actually run, not on how many
people or projects you have. Projects and agents are unlimited on every plan.

**Prices are on [hezo.ai/pricing](https://hezo.ai/pricing).** This page
explains what you are buying.

## The two numbers a plan sets

**Concurrent containers** is how much work can happen at the same time. Every
agent works inside its own container, so this is the width of your team's busy
moments, not a limit on how many agents you may hire.

**Container-hours a month** is the budget those containers draw from. One
container running for one hour is one container-hour; five containers running
for twelve minutes is also one. Time is metered while a container is up, so an
idle team costs nothing.

Both reset with your billing period. See
[Budgets & cost control](/docs/concepts/budgets-and-costs) for the in-app
ledger, which works the same as it does on a self-hosted instance.

**Your model spend is separate and is not billed by us.** You connect your own
provider accounts, and they bill you directly. See
[AI model support](/docs/ai-models).

## The free trial

Every account starts with a **seven-day free trial, and we do not ask for a
card**. The trial grants a flat ten container-hours and three concurrent
containers, the same for everyone.

The clock starts when you take your address, and the trial ends at whichever
comes first: seven days, or ten container-hours.

**You do not pick a plan to start the trial.** You pick one when you subscribe,
which is the right order - container-hours are hard to predict before you have
watched a team work for a week. If you arrived from a plan on our pricing page,
that plan is the one waiting for you when you subscribe.

## When you need more hours

**Buy a pack.** Hour packs are a one-off purchase that sits behind your plan's
own hours and is spent only once those run out. Hours you buy never expire.

**Automatic top-ups are off** until you turn them on. If you do, you set how
many packs a period may buy on its own.

**Or move up a plan**, which is usually better value than repeated packs.

Nothing is charged above your plan without you asking for it. If you run out of
hours and have no packs, no new container starts until the period rolls over or
you buy more - work in flight is not interrupted mid-run.

## Changing plan

- **Moving up takes effect immediately.** The difference settles on your next
  invoice rather than being charged on the spot.
- **Moving down takes effect at the end of the period** you have paid for.
- **Switching between monthly and annual** takes effect at the end of the
  period, in both directions.

Annual is billed once a year and works out cheaper per month.

## Invoices and payment details

Payment is handled by Stripe, which is the merchant of record for Hezo Cloud -
so Stripe collects and remits sales tax where it applies, and your card details
never reach us. Invoices and payment methods live in the billing portal, which
you reach from your dashboard.

## If a payment stops

Nothing is ever deleted because you stopped paying.

**First your instance is held.** That happens when a trial ends without a
subscription, or when a payment finally fails after Stripe has retried. Your
instance stays up and keeps reporting, but its agents stop and its address
answers with a short notice instead. A hold lasts **fourteen days**, and paying
inside that window brings everything straight back.

**Then it is shut down.** After the hold, the instance itself is removed, but
**your database and your files are kept**. Subscribing again rebuilds the
instance and you unlock it with the recovery phrase you already have.

Cancelling is different from either: you keep the service until the end of the
period you have paid for.

## Deleting your account

You can delete your account at any time, which cancels your subscription at the
same time. **It is immediate and it cannot be undone**: your instance, its
database and every file you have stored are removed, there is no export, and we
keep no backup we could restore for you. See
[Data & security on Hezo Cloud](/docs/cloud/data-and-security).
