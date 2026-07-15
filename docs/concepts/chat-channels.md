---
title: Chat & Telegram
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

## Chatting from Telegram

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
  an admin with the **Manage topics** permission. Each topic becomes its own conversation,
  mirrored alongside your web threads.

Everything you say from Telegram lands in the same CEO chat you see in the web app, so you
can start a thread on your phone and pick it up later in the browser.

> **Security.** Your bot token is stored encrypted and is never exposed to agents. Only the
> identities you add to the allowlist can chat — an unknown sender gets no reply.
