---
title: Slack
order: 18.5
section: Concepts
---

# Slack: the CEO as a coworker

The Slack integration puts the Hezo **CEO in your team's Slack workspace as a
coworker**. Invite it to a channel, @-mention it, and it reads the surrounding
conversation for context, does the work with its usual tools, and replies in the
thread — visible to everyone there.

Typical flow: you and a colleague hash something out in `#product`, then write
`@hezo make a plan from our chat and create the tasks`. The CEO pulls the recent
channel history, reads what you agreed, creates the tasks in the right project, and
posts a summary back into the thread.

Both integration modes are supported (see
[Chat & messaging apps](/docs/concepts/chat-channels)):

- **Coworker mode** — @-mention the bot in any channel it was invited to. Replies stay
  in the Slack thread; these conversations never appear in the web chatbox.
- **Assistant (DM) mode** — DM the bot for a private CEO chat, mirrored with the web
  chatbox. Like Telegram, DMs require your Slack account to be linked under **Allowed
  identities**.

## Setup

Hezo connects to Slack over **Socket Mode** — an outbound connection from your Hezo
server, so it works even when your instance has no public URL.

1. **Create the Slack app.** Go to [api.slack.com/apps](https://api.slack.com/apps) →
   **Create New App** → **From a manifest**, pick your workspace, and paste the manifest
   below.
2. **Get the two tokens.**
   - Under **Basic Information → App-Level Tokens**, generate a token with the
     `connections:write` scope — this is the **app-level token** (`xapp-…`).
   - Under **Install App**, install it to your workspace and copy the **bot token**
     (`xoxb-…`).
3. **Paste both into Hezo.** On **Settings → Chat channels → Slack**, paste both tokens,
   tick **Enabled**, and save. Hezo verifies both tokens against Slack and connects.
4. **Invite the bot.** In Slack, `/invite @hezo` in any channel where you want the CEO
   as a coworker. For DMs, also link your Slack member ID (profile → **⋯** → **Copy
   member ID**, starts with `U`) under **Allowed identities**.

### App manifest

```yaml
display_information:
  name: Hezo
  description: The Hezo CEO, as a coworker in your channels
features:
  bot_user:
    display_name: hezo
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## How coworker mode behaves

- **Mention-driven.** The CEO only acts when @-mentioned. It never posts unprompted and
  never reacts to messages that don't mention it.
- **Channel history as context.** On a mention it fetches the recent conversation — the
  whole thread when you mention it inside one, or the channel's recent messages for a
  top-level mention — as background for that one reply. The history is read fresh each
  time, not stored.
- **Replies in-thread.** A top-level mention starts a thread under your message; every
  follow-up mention in that thread continues the same conversation, and the CEO
  remembers its own exchanges there.
- **Full CEO powers.** It can list projects and tasks, create tasks, write documents,
  and everything else the CEO can do from the web chat — just addressed from Slack.
- **Channel-scoped privacy.** The bot can only read channels it was explicitly invited
  to; Slack enforces this. Removing it from a channel removes its access. Anyone in an
  invited channel may mention it — the invite is the authorization.
- **Not mirrored.** Coworker conversations live in Slack. They don't appear in the web
  chatbox thread list, and the CEO's private long-term chat memory is not shared with
  group channels.

> **Security.** Both tokens are stored encrypted in the global secrets vault, scoped to
> `slack.com`, and are never exposed to agents or agent runs — the trusted Hezo server
> talks to Slack directly. Channel history is fetched on demand for a single reply and
> is not persisted.
