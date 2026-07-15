# Deferred: Discord chat channel adapter

Discord is a planned CEO-chat avenue, deliberately **not built yet**. The generic
channel-adapter core (`packages/server/src/services/chat-channels/`) was designed so
Discord slots in as **one adapter file + one additive enum migration**, with no
changes to the manager, the conversation model, the generic webhook route, the
identity allowlist, or the web core. This doc is the shovel-ready plan.

Telegram (webhook transport) was shipped first because it needs no long-lived
connection and no single-instance ownership. Discord validates the same
`ChatChannelAdapter` interface against the hard case: a persistent gateway.

## What building it entails

1. **Enum migration (additive).** Add `discord` to the `chat_channel` enum — take the
   next free migration number at that time:
   ```sql
   ALTER TYPE chat_channel ADD VALUE IF NOT EXISTS 'discord';
   ```
   Add `Discord: 'discord'` to `ChatChannel` in `packages/shared/src/types/common.ts`,
   and ship a `migrate-NNN-add-discord-channel.test.ts` (copy the pattern of
   `packages/server/test/migrate-027-add-api-connector-transport.test.ts`). No other
   schema change: `chat_channel_configs.metadata` already holds channel-specific
   settings (Discord application id, guild id), and `chat_identity_links` /
   `chat_conversations` are already channel-agnostic.

2. **Adapter** `packages/server/src/services/chat-channels/discord.ts` implementing
   `ChatChannelAdapter`, plus a Gateway transport. Register it in
   `buildChatChannelRegistry` (`chat-channels/index.ts`). The generic adapter-start
   loop (`registry.startAll()` on unlock, in `startup.ts`) brings it online for an
   enabled config — no Discord special-case in startup.
   - `start()`: open a WebSocket to `wss://gateway.discord.gg`, send IDENTIFY with the
     `GUILD_MESSAGES | MESSAGE_CONTENT` intents, handle the hello/heartbeat interval,
     RESUME on reconnect (store `session_id` + last sequence), exponential backoff on
     close. Fatal close codes (4004 auth failed, 4014 disallowed intent) disable the
     config and surface a UI error rather than hot-looping.
   - `stop()`: close the gateway connection.
   - `parseInbound(raw)`: a `MESSAGE_CREATE` event → `{ externalUserId: author.id,
     externalThreadId: channel_id (or thread id), text }`; ignore the bot's own
     messages. Feed the result to the shared `ingestInboundEvent` (same path Telegram
     uses) via the gateway's message handler.
   - `deliver(reply)`: `POST /channels/{id}/messages` with the in-process-decrypted bot
     token (direct to `discord.com`, not the egress proxy — same trusted-server
     rationale as Telegram; the token is stored scoped to `discord.com`, see
     `CHANNEL_HOST` in `routes/chat-channels.ts`).
   - `createThread(title)` / `closeThread(id)`: native Discord thread start / archive
     (`POST /channels/{id}/threads`, `PATCH` archived=true); store the created thread
     id as the conversation's `external_thread_id`.

3. **Single-instance ownership (the key risk).** A Gateway connection must run on
   **exactly one process**. Hezo is single-process today (one `chatSessionManager`, one
   HQ container), so this holds, but a future multi-instance deploy would open duplicate
   gateways and deliver every message twice. Guard it with a DB advisory lock or a
   `chat_channel_configs.metadata.gateway_owner` lease acquired in the adapter's
   `start()`. Put the lease in the generic adapter-start path so **every** future
   long-lived adapter inherits it.

4. **Setup friction to document.** Message Content is a **privileged intent** — the
   operator must enable it in the Discord developer portal, and it becomes
   review-gated once the bot joins 100+ servers. Surface this in the config UI and the
   docs page.

5. **UI/docs deltas when built.** Add a Discord section to the chat-channels settings
   page (`packages/web/src/routes/settings/chat-channels.tsx`) — application id + guild
   id go into `metadata`. Add a "Chat from Discord" docs page under `docs/`. The
   identity-link and conversation-lifecycle surfaces are already generic and need no
   change.

## What you do NOT touch

The whole point of the abstraction: `ChatSessionManager`, `ingestInboundEvent`, the
generic `POST /webhooks/chat/:channel/:secret` route (Discord uses the gateway, not the
webhook, but the route stays as-is for webhook channels), `chat_conversations` /
`chat_identity_links` / `chat_channel_configs`, and the web thread switcher all stay
unchanged. If building Discord requires editing any of them, the abstraction has a gap
worth fixing first.
