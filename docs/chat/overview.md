---
title: Overview
order: 17.1
section: Chat & messaging apps
---

# Chatting with your team

Chat is a first-class way to work in Hezo. The **CEO** - the global assistant that
coordinates every project - is one click away behind the **CEO monogram in the top
bar**, and every project agent has a **direct message** of its own, opened from the
chat cards at the bottom of the project menu. Ask what's blocked, think out loud,
have a project spun up, or talk a piece of work through with the teammate who owns it.

Chat opens in the **dock** - a compact panel anchored to the bottom-right corner (near
full-screen on a phone). The dropdown at the top of the dock switches rooms: the CEO
is pinned on top, the current project's agents follow, then the project's **group
rooms**, conversations from connected chat apps and, under **History**, closed
conversations that remain readable.

## Chat thinks, tasks work

A chat turn is for discussing, deciding and coordinating. The moment something needs
real work - code written, a document produced, research run - the agent files it as a
**task** and the work happens in a task run, with its own log, review and budget
accounting. You'll see the receipts in the conversation itself:

- **"Created WEB-53"** when a task is filed from your chat, linking straight to it.
- **"WEB-53 completed"** when it finishes, and **"WEB-53 blocked - needs you"** when
  it stalls on something only you can resolve.

So a request made in chat never disappears into silence: the conversation carries the
paper trail of the work it started.

## Talking to the CEO

The CEO chat is **one continuous conversation**, like any messaging app - no separate
threads to manage. It has long-term memory, so it remembers your preferences and past
decisions, and older exchanges are compacted into that memory rather than lost.
Conversations that existed before this model (including ones converted into tasks)
stay readable under **History** in the room switcher.

The CEO works across every project: it can answer for the whole org, file tasks into
any project, and set up new projects with you. On a fresh instance, the home page IS
the CEO conversation - tell it what you want to build and it takes it from there.
Once projects exist the home page becomes the dashboard; if you'd rather keep landing
in the chat (or pin the dashboard outright), set **Landing view** under
**Settings → Appearance**.

## Talking to a project agent

Every enabled agent on a project's roster can be messaged directly - from the chat
cards in the project menu, or from the dock's room switcher while you're in the
project. A DM is one continuous conversation per agent. Agents answer questions,
discuss approach and coordinate; anything needing a run becomes a task on the project,
with the same receipts as above. An unread reply marks the agent's card and shows a
one-line preview.

## Group rooms

A **group room** puts you and several project agents in one conversation. Every
project has a built-in **General** room that always contains the whole roster (it
follows hires and departures on its own, and can be renamed but not closed), and the
**+** beside the dock's room switcher creates rooms of your own - pick a name and the
teammates in it.

Who replies is always your call:

- **Mention someone** - `@designer` - and they reply. Mention several and they reply
  one at a time, in the order you named them (at most three per message); the queue
  shows as chips you can cancel before a reply starts.
- **Mention nobody** and the last teammate who spoke replies - the conversation stays
  with whoever you were already talking to. Before anyone has spoken, an untagged
  message just posts, with a hint to tag someone.
- **Agents never trigger each other.** A reply that says a teammate should weigh in
  grows an **Ask @name** chip - tapping it drafts the mention for you, and nothing is
  sent until you send it.

A room keeps its own shared memory of settled decisions, maintained automatically the
same way the CEO's is. It belongs to the room: nothing from any agent's private DM
memory appears there, and room chatter is never folded into a DM memory.

## Turning a message into a task

Any message in a DM, group room or the CEO chat can become a task: the convert button
beside the message opens a small dialog with the title filled in. In a DM the task
defaults to that agent; in a group room to the Captain, who triages; from the CEO
chat you pick the project. The conversation stays exactly as it was, and the usual
receipts (created, completed, blocked) flow back into it.

## Suggested replies

When the natural next response is one of a few short choices - confirm or decline,
pick an option - the agent may offer up to three **one-tap replies** under its
message. Tapping one sends exactly that text as your message, nothing more; they
disappear as soon as you start typing your own answer.

## Why the dots continue after an answer appears

A reply can be fully readable while the agent is still working. When that happens the
dots stay under the bubble, and if the agent is using a tool the dots say which one -
"Using list_tasks", for example. That is the agent acting on what you asked: reading a
project's real state, creating a task, writing a document. The reply is finished when
the dots disappear.

You never have to wait for them. Typing during that window queues your next message
(see below), and holding the send button cuts in.

## When a comment an agent posted reached nobody

The CEO can comment on any project's task from chat. If one of those comments names a
teammate without actually notifying them - writing the name plainly, or with the
passive `@@name` form - nobody is woken, and the task can sit waiting on someone who
was never told. When that happens a short note appears in the conversation naming the
task and the teammate, so you can ask for a proper `@name` mention. It is a notice,
not an error: if the agent was only referring to a teammate rather than handing work
over, nothing needs doing.

## Sending while the agent is still replying

You don't have to wait for a reply to finish before typing the next thing. While the
agent is working, the send button changes to **Queue**:

- **Press Enter (or tap Queue)** and your message is parked, not sent. It shows up at
  the bottom of the conversation as a dashed bubble, and the header shows how many
  are waiting.
- **Changed your mind?** Every queued message has a **✕** next to it. Removing one
  drops it completely - it never reaches the agent. The **✕** disappears once the
  queue has been sent, because by then there is nothing to take back.
- **When the reply finishes**, everything you queued is sent together, and the agent
  answers all of it in one go rather than replying to your first message before it
  has seen the rest.

### Cutting in

Sometimes you want to stop a reply mid-answer - you spotted a mistake, or you meant
something else. That is deliberate, so it takes a deliberate action:

- **Hold the send button.** Hold it down and it fills up, then changes to
  **Send now**. Let go and the current reply stops where it is (it stays in the
  conversation, marked as interrupted) and your message starts a fresh answer. Let go
  early, or drag your finger or cursor off the button, and nothing is interrupted.
- **Or press Cmd+Enter** (**Ctrl+Enter** on Windows and Linux) for the same thing
  from the keyboard.

Anything already queued stays queued behind the message you cut in with. The queue
lives in your browser, per room, and does not survive a page reload.

## What a chat turn costs

Chat is metered like everything else. Each turn's model spend lands on the agent's
project (the CEO's on HQ), and the containers chat runs in count toward the monthly
container-hours allowance - the CEO's included. If a budget or the hours allowance
runs out, the conversation says so in place; send again once there is room and it
carries on from where you left off.

When the container-hours allowance is spent, the composer says so before you type: a
reply that needs a new container will not start until the month turns or the allowance
is raised. The composer stays open, because a reply that lands on a container already
running still goes through. Admins get a link straight to the Hours tab, where the
allowance is set.
See [Budgets & cost control](/docs/concepts/budgets-and-costs).

## How conversations work across chat apps

The CEO is also reachable from external chat apps -
[Telegram](/docs/chat/telegram), [Slack](/docs/chat/slack), and
[Discord](/docs/chat/discord). The model is simple:

- **Every surface owns its own conversations.** A Telegram DM is one conversation. A
  Slack DM is a different one. A topic in your Telegram Topics group, a Slack channel,
  a Discord channel - each is its own. Conversations never fork across apps: nothing
  you start in one app ever shows up *inside* another app.
- **The web dock is the hub.** Its room switcher lists everything - your CEO stream
  plus every conversation from every connected app, each badged with where it lives.
  The web view is the one place you can see everything.
- **Replies go where you asked.** Message the bot from Telegram and the answer arrives
  in Telegram. Ask from the web and the answer streams here. Each reply is delivered
  to the surface the question came from - including when you open an app's
  conversation in the web view and continue it there (the answer then appears in the
  web view, not in the app).
- **Closing a conversation ends it for good.** Close an app's conversation from the
  web view and the next message from that app starts a **fresh** one.

## Two modes: assistant and coworker

Each app connects in one or both of two modes:

- **Assistant (DM) mode** - you message the bot **privately**, and the conversation is
  a real-time CEO chat. It's your personal remote control for the CEO, so only
  identities you explicitly link under **Settings → Chat → Allowed identities**
  may chat; unknown senders get no reply. These conversations are fully interactive
  from the web view too.
- **Coworker (channel) mode** - the CEO joins a **group channel your team already
  uses**. Invite the bot to a channel, and anyone there can @-mention it: it reads the
  recent channel conversation for context, does the work, and replies in the channel.
  Discuss something with a colleague, then @-mention the CEO and ask it to *"make a
  plan from our chat"* or *"document what we agreed"*. **Inviting the bot is the
  authorization** - no identity linking needed. Channel conversations appear in the
  web dock under **Linked channels**, read-only: you can follow everything from the
  web, but the conversation belongs to the channel, so you continue it by mentioning
  the bot there.

What coworker mode deliberately keeps separate: the CEO's private long-term chat
memory (your preferences, past decisions) is **never** fed into group channels, and
group chatter is never folded into it. Your personal assistant and your team's
coworker share the same brain for work, not for your private conversation history.

## Per-app guides

| App | Assistant (DM) mode | Coworker (channel) mode | Setup |
|---|---|---|---|
| [Telegram](/docs/chat/telegram) | Private DM + optional Topics supergroup (parallel personal threads) | Groups the bot is added to (privacy mode off) | Bot token from @BotFather |
| [Slack](/docs/chat/slack) | DMs with the bot | Channels the bot is invited to | App manifest + two tokens (Socket Mode) |
| [Discord](/docs/chat/discord) | DMs with the bot | Server channels, on @-mention | Bot token + Message Content intent |

> **Security.** Bot tokens are stored encrypted in the global secrets vault and are
> never exposed to agents or agent runs - the trusted Hezo server talks to each platform
> directly. In assistant mode, only allowlisted identities can chat. In coworker mode,
> access is channel-scoped: the bot only sees channels it was explicitly invited to, and
> removing it removes its access.
