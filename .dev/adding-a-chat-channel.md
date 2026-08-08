# Adding a chat channel adapter

The contributor guide for wiring a new external chat avenue to the CEO (Telegram, Slack, Discord today; WhatsApp's enum value exists with no adapter yet). For the conversation data model and how a chat turn executes, see `architecture.md` § 3 (data model) and § 5 (agent execution).

External chat avenues use a channel-adapter abstraction plus registry in `services/chat-channels/`. The manager (`chat-session-manager.ts`), the generic inbound webhook route (`routes/chat-webhooks.ts`), the conversation model and the web thread switcher are channel-agnostic — they resolve a channel only through the registry, never by branching on a platform name.

## Thread model (no mirroring)

Every conversation has exactly one home surface — a web thread, a platform DM, a platform channel — each its own `chat_conversations` row, and `(channel, external_thread_id, closed_at IS NULL)` is the inbound routing key (there is no bindings table).

- **One home surface per thread.** An adapter never creates threads on other channels and never re-implements cross-surface sync. Closing a thread (web ✕, or the platform's own close via `parseClose` → `closeConversationByExternalThread`) ends it; the next inbound message on that surface starts a fresh conversation.
- **Reply-where-asked.** A turn's reply goes to the surface its triggering message came from — the manager's `finalize` calls `ChannelHooks.deliver` with the **turn's** origin channel. A web-composed turn into an external assistant thread answers on web only; an adapter's `deliver` only addresses its own platform.
- **The web view is the hub** — `listConversations` returns every conversation of every kind with `channel` + `kind`. Assistant threads stay fully interactive from web; **coworker threads are read-only there** (`POST /api/chat/messages` 409s; the write surface is the platform, where the ephemeral channel context lives).
- **History capability is required for group mode.** A group-capable adapter MUST supply real channel context via `fetchThreadContext` — fetch-on-demand where the platform has a history API (Slack `conversations.history`/`replies`, Discord `GET /channels/{id}/messages`), or passive accumulation where it doesn't (Telegram: `observeMessage` → the bounded `chat_observed_messages` buffer, ~200/chat, topic-scoped reads). A coworker that can't see the channel is pointless; don't ship group mode without it.

## Two integration modes

Discriminated by `chat_conversations.kind`; an adapter implements one or both:

- **Assistant/DM** (`kind='assistant'`) — a private chat with the bot is a real-time CEO thread listed in the web chatbox. Identity-allowlist gated.
- **Group/coworker** (`kind='coworker'`) — the CEO is invited into a group channel and responds to @-mentions with platform history as ephemeral context, replying in-thread. **Channel invite is the authorization** (no identity gate; a link only enriches attribution). Read-only in web; turns queue instead of interrupting; no compaction or auto-title, so the operator's long-term chat memory stays out of group prompts.

## To add a channel

1. Add a `ChatChannel` enum value in `packages/shared/src/types/common.ts` **and** an additive `ALTER TYPE chat_channel ADD VALUE` migration with a data-preservation test.
2. Implement a `ChatChannelAdapter` (`chat-channels/<channel>.ts`) and register it in `buildChatChannelRegistry` (`chat-channels/index.ts`). Required: `parseInbound` (raw event → `InboundChatEvent`) and `deliver` (splitting via `splitMessageForLimit` from `chat-channels/format.ts` where the platform caps message length). Optional: `start`/`stop` (webhook registration or a persistent transport), `closeThread` + `parseClose`, `observeMessage`, `promptToLink`/`validateConfig`. Group mode is the optional trio `parseGroupMention`/`supportsGroupMode`/`fetchThreadContext` — the adapter owns the platform history fetch and its filtering, the core owns prompt formatting via `formatGroupContextBlock`, and a one-hop reply-quote rides on the event as `inlineContext`.
3. Inbound transport: webhook channels flow through the generic route, which dispatches `parseGroupMention` → `parseInbound` → `parseClose` → `observeMessage`; a socket-transport adapter pushes parsed events through the `InboundEventSink` on its deps instead. **DMs and group mentions have two deliberately separate ingest paths** (`ingestInboundEvent` and `ingestGroupMentionEvent` in `chat-channels/ingest-group.ts`) — never overload the DM one with group semantics. A **true-fanout** transport (Discord's gateway, where every open connection receives every event, unlike Slack's load-balanced Socket Mode) must also hold the single-instance ownership lease (`metadata.gateway_owner`, TTL-renewed from the heartbeat; stand down on loss) so two instances sharing a DB never double-answer.
4. Store all channel-specific settings in `chat_channel_configs.metadata` (jsonb) — **never add per-channel columns**. The bot token goes in the `secrets` vault (referenced by name) and is decrypted **in-process** by trusted server code, NOT via the agent egress proxy (that mechanism is for agent runs). A channel needing a second secret stores its vault name in metadata (Slack: `metadata.app_token_secret` → `SLACK_APP_TOKEN`; the config PUT route handles `app_token` generically).
5. Ship the channel's unit tests (parse → event shape, mention/reply detection, close no-op safety) plus routing coverage (crib `chat-thread-routing.test.ts`: no cross-surface thread creation, a web turn into an external thread answers on web only, close → fresh thread) and, for a group-capable adapter, coworker-semantics coverage (crib `chat-group-ingest.test.ts`: coworker kind, reply-to-origin, read-only web, ephemeral context never persisted).

**Do not touch** the manager, either ingest path, the generic webhook route, or the conversation/identity schema — if a new channel forces a change there, close the gap in the abstraction instead. Worked examples in `chat-channels/`: `slack.ts` + `slack-socket.ts` (persistent transport), `discord.ts` + `discord-gateway.ts` (true-fanout + lease), `telegram.ts` (webhook + passive accumulation).
