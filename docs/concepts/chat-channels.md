---
title: Chat & messaging apps
order: 18
section: Concepts
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

## Connecting chat apps: two modes

The CEO can also be reached from external chat apps, in two different modes. Every app
integration supports one or both:

- **Assistant (DM) mode** — you message the bot privately, and the conversation is a
  real-time CEO chat thread **mirrored with the web chatbox**: same messages, both
  places, close it anywhere. It's your personal remote control for the CEO, so only
  identities you explicitly link may chat. Telegram works this way (and Slack DMs too).
- **Coworker (channel) mode** — the CEO joins a **group channel your team already uses**.
  Invite the bot to a channel, and anyone there can @-mention it: it reads the recent
  channel or thread history for context, does the work, and replies in the thread.
  Discuss something with a colleague, then @-mention the CEO and ask it to *"make a plan
  from our chat"* or *"document what we agreed"*. These conversations belong to the
  channel — they are **not** mirrored into the web chatbox, and inviting the bot to the
  channel is what authorizes it (no identity linking needed). Slack works this way — see
  [Slack](/docs/concepts/chat-slack).

## Chatting from Telegram (assistant mode)

You can talk to the CEO from **Telegram** as well as the web app — handy when you're away
from your desk. Set it up from **Settings → Chat channels**:

1. **Create a bot.** In Telegram, message [@BotFather](https://t.me/BotFather), create a
   bot, and copy its token.
2. **Paste the token.** On the Chat channels page, paste the token into the Telegram
   section, tick **Enabled**, and save. Hezo registers the inbound connection for you.
3. **Link your account.** Only accounts you explicitly allow may chat. Find your Telegram
   numeric user id (message [@userinfobot](https://t.me/userinfobot)), then add it under
   **Allowed identities** — it links to your Hezo account. Anyone not on the allowlist is
   ignored.

Now message your bot and the CEO replies right in Telegram.

### Threads in Telegram

- A **private chat** with your bot is a single conversation.
- For **multiple threads** in Telegram, add the bot to a **Topics-enabled supergroup** as
  an admin with the **Manage topics** permission. Each topic is one conversation.

### One thread, both places

Once a Topics supergroup is connected, threads stay **mirrored** between the app and
Telegram:

- **Start a thread in the web chatbox** → a matching **topic appears in your Telegram
  group** automatically, and vice versa — a new topic in Telegram shows up as a thread in
  the app.
- **Messages sync both ways** — what you say and the CEO's replies appear on *both*
  surfaces, so it's genuinely the same conversation. Start it on your laptop, continue on
  your phone.
- **Close it anywhere, it closes everywhere** — closing a thread in the app archives its
  Telegram topic, and closing the topic in Telegram closes the thread in the app.

(Without a Topics supergroup — e.g. a plain DM — Telegram just has the one conversation, and
web threads stay in the app.)

> **Security.** Your bot token is stored encrypted and is never exposed to agents. In
> assistant mode, only the identities you add to the allowlist can chat — an unknown
> sender gets no reply. In coworker mode, access is channel-scoped: the bot only sees
> channels it was explicitly invited to.
