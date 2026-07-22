---
title: Discord
order: 18.7
section: Concepts
---

# Discord: the CEO on your server

The Discord integration puts the Hezo **CEO on your Discord server as a coworker**.
@-mention it in a channel and it reads the recent conversation for context, does the
work with its usual tools, and replies right there. It also answers DMs as a personal
assistant.

Both integration modes are supported (see
[Chat & messaging apps](/docs/concepts/chat-channels)):

- **Coworker mode** — @-mention the bot in any channel on a server it has joined.
  Replies land in the channel; the conversation also shows up read-only in the web
  chatbox under **Team channels**.
- **Assistant (DM) mode** — DM the bot for a private CEO chat. The DM is its own
  thread, listed in the web chatbox alongside your web threads. DMs require your
  Discord account to be linked under **Allowed identities**.

## Setup

Hezo connects to Discord over an outbound **gateway connection** from your Hezo server,
so it works even when your instance has no public URL.

1. **Create the bot.** Go to the
   [Discord Developer Portal](https://discord.com/developers/applications) → **New
   Application**, then open the **Bot** tab.
2. **Enable the Message Content intent.** Under **Bot → Privileged Gateway Intents**,
   turn on **Message Content Intent** — without it Discord hides message text from the
   bot, so it can't see mentions or build context.
3. **Copy the bot token** (Bot tab → **Reset Token**).
4. **Invite the bot to your server.** Under **OAuth2 → URL Generator**, select the
   `bot` scope with the **View Channels**, **Send Messages**, and **Read Message
   History** permissions, open the generated URL, and pick your server.
5. **Paste the token into Hezo.** On **Settings → Chat channels → Discord**, paste the
   bot token, tick **Enabled**, and save. Hezo verifies the token and connects.
6. **For DMs**, link your Discord user ID under **Allowed identities**: in Discord,
   enable **Developer Mode** (Settings → Advanced), then right-click your name →
   **Copy User ID**.

## How coworker mode behaves

- **Mention-driven.** The CEO only acts when @-mentioned (or when you reply to one of
  its messages). It never posts unprompted.
- **Channel history as context.** On a mention it fetches the channel's recent messages
  from Discord as background for that one reply. The history is read fresh each time,
  not stored.
- **Every channel is its own thread.** Each Discord channel the bot is mentioned in
  becomes its own conversation in the web view — and Discord **threads** count as their
  own channels, so a thread spun off a message gets its own separate conversation too.
- **Replies anchor to your message.** The CEO's answer replies to the message that
  mentioned it, so it reads naturally in a busy channel.
- **Full CEO powers.** It can list projects and tasks, create tasks, write documents,
  and everything else the CEO can do from the web chat — just addressed from Discord.
- **Server-scoped privacy.** The bot only sees channels its role can read on servers it
  was invited to; kicking it removes its access. Anyone who can @-mention it may use it
  — the invite is the authorization.

> **Security.** The bot token is stored encrypted in the global secrets vault, scoped
> to `discord.com`, and is never exposed to agents or agent runs — the trusted Hezo
> server talks to Discord directly. Channel history is fetched on demand for a single
> reply and is not persisted. The CEO's private long-term chat memory is never shared
> with server channels.
