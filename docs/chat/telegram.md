---
title: Telegram
order: 17.2
section: Chat & messaging apps
---

# Telegram: the CEO in your pocket

The Telegram integration connects the Hezo **CEO** to Telegram in both modes (see
[Chat & messaging apps](/docs/chat/overview)):

- **Assistant (DM) mode** - DM your bot for a private CEO chat, with optional parallel
  threads via a Topics supergroup. Allowlisted identities only.
- **Coworker (group) mode** - add the bot to any group your team uses, and anyone there
  can mention it; it answers with the group's recent messages as context.

## Setup

Set it up from **Settings → Chat channels**:

1. **Create a bot.** In Telegram, message [@BotFather](https://t.me/BotFather), create a
   bot, and copy its token.
2. **Paste the token.** On the Chat channels page, paste the token into the Telegram
   section, tick **Enabled**, and save. Hezo registers the inbound connection for you.
3. **Link your account.** Only accounts you explicitly allow may DM. Find your Telegram
   numeric user id (message [@userinfobot](https://t.me/userinfobot)), then add it under
   **Allowed identities** - it links to your Hezo account. Anyone not on the allowlist is
   ignored.

Now message your bot and the CEO replies right in Telegram.

## Threads in Telegram (assistant mode)

- A **private DM** with your bot is one conversation. Close it from the web view and
  your next DM starts a fresh thread.
- For **multiple parallel threads**, add the bot to a **Topics-enabled supergroup** as
  an admin with the **Manage topics** permission, and enter the group's id in the
  Telegram section (**Your Topics supergroup id**). Each topic is then its own personal
  CEO thread - closing a topic in Telegram closes the thread, and closing the thread
  from the web view archives the topic.

All of these threads are listed in the web chatbox alongside your web threads, badged
with their origin, and stay fully interactive there - with replies delivered to whichever
surface you asked from.

## Coworker mode: the CEO in your team's groups

Add the bot to any **other** group (one that isn't your designated Topics supergroup)
and it acts as a coworker there:

1. **Turn off privacy mode** so the bot can see the group's messages: message
   @BotFather → `/setprivacy` → select your bot → **Disable**. (With privacy mode on,
   Telegram only delivers commands and direct replies to bots - the bot can't see
   mentions or build context.)
2. **Add the bot to the group.** That's the authorization - anyone in the group can use
   it, with no identity linking.
3. **Mention it** (`@yourbotname do X`) or **reply to one of its messages**. It answers
   in the group, replying to your message directly.

**Context - what the bot can see.** Telegram offers bots no way to fetch a group's past
messages, so the CEO's context is what the bot has **witnessed since it joined**: Hezo
keeps a rolling buffer of the group's recent messages (about the last 200 per group) and
hands the recent window to the CEO when it's mentioned. If you reply to someone's
message when mentioning the bot, that quoted message rides along too. Messages sent
before the bot joined (or while the integration was disabled) are invisible to it.

In a **Topics-enabled group**, each topic is treated as its own conversation - mentions
in different topics land in different threads, and context stays per-topic.

Group conversations appear in the web chatbox under **Team channels**, read-only - you
can follow along from the web, but you continue the conversation by mentioning the bot
in the group.

> **Security.** Your bot token is stored encrypted and is never exposed to agents. DMs
> are allowlist-gated; groups are scoped by membership - the bot only sees groups it was
> explicitly added to, and its observed-message buffer is bounded and used only as
> context when it's mentioned. The CEO's private long-term chat memory is never shared
> with groups.
