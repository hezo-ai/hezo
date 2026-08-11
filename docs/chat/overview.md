---
title: Overview
order: 17.1
section: Chat & messaging apps
---

# Chatting with the CEO

The chatbox in the bottom-right corner is your direct, real-time line to the **CEO** -
the global assistant that coordinates every project. Ask it what's blocked, have it spin
up a project or a task, get a status read across the org, or just think out loud. It has
long-term memory, so it remembers your preferences and past decisions across the
conversation.

## Why the dots continue after an answer appears

A reply lands as a whole block rather than word by word, so the answer is often fully
readable while the CEO is still working. When that happens the dots stay under the
bubble, and if the CEO is using a tool the dots say which one - "Using list_tasks", for
example. That is the CEO acting on what you asked: reading a project's real state,
creating a task, writing a document. The reply is finished when the dots disappear.

You never have to wait for them. Typing during that window queues your next message
(see below), and holding the send button cuts in.

## When a comment the CEO posted reached nobody

The CEO can comment on any project's task from this chat. If one of those comments names
a teammate without actually notifying them - writing the name plainly, or with the
passive `@@name` form - nobody is woken, and the task can sit waiting on someone who was
never told. When that happens a short note appears in the conversation naming the task
and the teammate, so you can ask the CEO to post a proper `@name` mention. It is a
notice, not an error: if the CEO was only referring to a teammate rather than handing
work over, nothing needs doing.

## Sending while the CEO is still replying

You don't have to wait for a reply to finish before typing the next thing. While the
CEO is working, the send button changes to **Queue**:

- **Press Enter (or tap Queue)** and your message is parked, not sent. It shows up at
  the bottom of the conversation as a dashed bubble, and the header shows how many
  are waiting.
- **Changed your mind?** Every queued message has a **✕** next to it. Removing one
  drops it completely - it never reaches the CEO. The **✕** disappears once the
  queue has been sent, because by then there is nothing to take back.
- **When the reply finishes**, everything you queued is sent together, and the CEO
  answers all of it in one go rather than replying to your first message before it
  has seen the rest.

### Cutting in

Sometimes you want to stop the CEO mid-answer - you spotted a mistake, or you meant
something else. That is deliberate, so it takes a deliberate action:

- **Hold the send button.** Hold it down and it fills up, then changes to
  **Send now**. Let go and the current reply stops where it is (it stays in the
  conversation, marked as interrupted) and your message starts a fresh answer. Let go
  early, or drag your finger or cursor off the button, and nothing is interrupted.
- **Or press Cmd+Enter** (**Ctrl+Enter** on Windows and Linux) for the same thing
  from the keyboard.

Anything already queued stays queued behind the message you cut in with. The queue
lives in your browser, so it is per conversation thread and does not survive a page
reload.

## Conversation threads

The chatbox supports **multiple parallel threads**, so you can keep separate lines of
conversation going without them bleeding into each other - one for a launch you're
planning, another for an ad-hoc question, and so on.

- **Switch** threads with the dropdown at the top of the chatbox.
- **New thread** with the **＋** button.
- **Close** the active thread with the **✕** button (your main thread can't be closed).

Each thread keeps its own recent history and streams independently.

The chatbox remembers the thread you switched to, so closing and reopening it - or
reloading the page - picks that conversation back up instead of dropping you on your main
thread. The memory is per browser. If the thread you were on has been closed since (by you
here, in another tab, or on its own chat app), the chatbox falls back to your main thread.

## Converting a conversation into a task

When a chat with the CEO turns into real work, you don't have to retype it as a task -
convert the thread directly. The convert button in the chatbox header opens a small
dialog: pick the target project, optionally adjust the task title (the thread's own title
is the default), and confirm. Hezo then does the rest in one step:

- A **task is created** in the project you chose, assigned to the CEO. The conversation's
  transcript becomes the task description, so the CEO (and you) can re-read the whole
  exchange from the task itself. The CEO wakes on the assignment and picks the work up
  from there.
- The thread ends with a **meta message linking the new task**, so the pointer is part of
  the conversation's own record.
- The thread **closes but stays in your chat list** as a read-only record - unlike an
  ordinarily closed thread, which disappears. Follow up on the task, not in the thread.

Converting is available on your own web threads. Team-channel (coworker) threads live in
their channel and can't be converted from the web view. If a reply is still streaming,
wait for it to finish - converting is disabled mid-reply so nothing gets cut off.

Deleting the task later turns the thread into an ordinarily closed one, which removes it
from the chat list.

## How threads work across chat apps

The CEO is also reachable from external chat apps -
[Telegram](/docs/chat/telegram), [Slack](/docs/chat/slack), and
[Discord](/docs/chat/discord). The model is simple:

- **Every surface owns its own threads.** A Telegram DM is one thread. A Slack DM is a
  different thread. A topic in your Telegram Topics group, a Slack channel, a Discord
  channel - each is its own thread. Conversations never fork across apps: nothing you
  start in one app ever shows up *inside* another app.
- **The web chatbox is the hub.** It lists **all** threads - the ones you started here
  plus every conversation from every connected app, each badged with where it lives.
  The web view is the one place you can see everything.
- **Replies go where you asked.** Message the bot from Telegram and the answer arrives
  in Telegram. Ask from the web chatbox and the answer streams here. Each reply is
  delivered to the surface the question came from - including when you open an app's
  thread in the web view and continue it there (the answer then appears in the web view,
  not in the app).
- **Closing a thread ends it for good.** Close an app's thread from the web view and the
  next message from that app starts a **fresh** thread. Your chats stay tidy without any
  cross-app bookkeeping.

## Two modes: assistant and coworker

Each app connects in one or both of two modes:

- **Assistant (DM) mode** - you message the bot **privately**, and the conversation is a
  real-time CEO chat thread. It's your personal remote control for the CEO, so only
  identities you explicitly link under **Settings → Chat channels → Allowed identities**
  may chat; unknown senders get no reply. These threads are fully interactive from the
  web view too.
- **Coworker (channel) mode** - the CEO joins a **group channel your team already
  uses**. Invite the bot to a channel, and anyone there can @-mention it: it reads the
  recent channel conversation for context, does the work, and replies in the channel.
  Discuss something with a colleague, then @-mention the CEO and ask it to *"make a plan
  from our chat"* or *"document what we agreed"*. **Inviting the bot is the
  authorization** - no identity linking needed. Channel threads appear in the web
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
> never exposed to agents or agent runs - the trusted Hezo server talks to each platform
> directly. In assistant mode, only allowlisted identities can chat. In coworker mode,
> access is channel-scoped: the bot only sees channels it was explicitly invited to, and
> removing it removes its access.
