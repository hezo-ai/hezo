---
title: Overview
order: 17.1
section: Chat & messaging apps
---

# Chatting with the CEO

The chatbox in the bottom-right corner is your direct, real-time line to the **CEO** —
the global assistant that coordinates every project. Ask it what's blocked, have it spin
up a project or a task, get a status read across the org, or just think out loud. It has
long-term memory, so it remembers your preferences and past decisions across the
conversation.

## Conversation threads

The chatbox supports **multiple parallel threads**, so you can keep separate lines of
conversation going without them bleeding into each other — one for a launch you're
planning, another for an ad-hoc question, and so on.

- **Switch** threads with the dropdown at the top of the chatbox.
- **New thread** with the **＋** button.
- **Close** the active thread with the **✕** button (your main thread can't be closed).

Each thread keeps its own recent history and streams independently.

## How threads work across chat apps

The CEO is also reachable from external chat apps —
[Telegram](/docs/chat/telegram), [Slack](/docs/chat/slack), and
[Discord](/docs/chat/discord). The model is simple:

- **Every surface owns its own threads.** A Telegram DM is one thread. A Slack DM is a
  different thread. A topic in your Telegram Topics group, a Slack channel, a Discord
  channel — each is its own thread. Conversations never fork across apps: nothing you
  start in one app ever shows up *inside* another app.
- **The web chatbox is the hub.** It lists **all** threads — the ones you started here
  plus every conversation from every connected app, each badged with where it lives.
  The web view is the one place you can see everything.
- **Replies go where you asked.** Message the bot from Telegram and the answer arrives
  in Telegram. Ask from the web chatbox and the answer streams here. Each reply is
  delivered to the surface the question came from — including when you open an app's
  thread in the web view and continue it there (the answer then appears in the web view,
  not in the app).
- **Closing a thread ends it for good.** Close an app's thread from the web view and the
  next message from that app starts a **fresh** thread. Your chats stay tidy without any
  cross-app bookkeeping.

## Two modes: assistant and coworker

Each app connects in one or both of two modes:

- **Assistant (DM) mode** — you message the bot **privately**, and the conversation is a
  real-time CEO chat thread. It's your personal remote control for the CEO, so only
  identities you explicitly link under **Settings → Chat channels → Allowed identities**
  may chat; unknown senders get no reply. These threads are fully interactive from the
  web view too.
- **Coworker (channel) mode** — the CEO joins a **group channel your team already
  uses**. Invite the bot to a channel, and anyone there can @-mention it: it reads the
  recent channel conversation for context, does the work, and replies in the channel.
  Discuss something with a colleague, then @-mention the CEO and ask it to *"make a plan
  from our chat"* or *"document what we agreed"*. **Inviting the bot is the
  authorization** — no identity linking needed. Channel threads appear in the web
  chatbox under **Team channels**, read-only: you can follow everything from the web,
  but the conversation belongs to the channel, so you continue it by mentioning the bot
  there.

What coworker mode deliberately keeps separate: the CEO's private long-term chat memory
(your preferences, past decisions) is **never** fed into group channels, and group
chatter is never folded into it. Your personal assistant and your team's coworker share
the same brain for work, not for your private conversation history.

## Per-app guides

| App | Assistant (DM) mode | Coworker (channel) mode | Setup |
|---|---|---|---|
| [Telegram](/docs/chat/telegram) | Private DM + optional Topics supergroup (parallel personal threads) | Groups the bot is added to (privacy mode off) | Bot token from @BotFather |
| [Slack](/docs/chat/slack) | DMs with the bot | Channels the bot is invited to | App manifest + two tokens (Socket Mode) |
| [Discord](/docs/chat/discord) | DMs with the bot | Server channels, on @-mention | Bot token + Message Content intent |

> **Security.** Bot tokens are stored encrypted in the global secrets vault and are
> never exposed to agents or agent runs — the trusted Hezo server talks to each platform
> directly. In assistant mode, only allowlisted identities can chat. In coworker mode,
> access is channel-scoped: the bot only sees channels it was explicitly invited to, and
> removing it removes its access.
