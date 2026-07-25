import { ChatConversationKind } from '@hezo/shared';
import { logger } from '../../logger';
import type { IngestDeps } from './ingest';
import { resolveLinkedUser } from './ingest';
import type { ChatChannelAdapter, InboundGroupMentionEvent, ThreadContextMessage } from './types';

const log = logger.child('chat-channels');

/**
 * Format an adapter's fetched platform history into the ephemeral prompt section
 * for one coworker-mode turn. Core-owned so the prompt shape is identical across
 * channels (Slack now, WhatsApp groups later). Pure — unit-tested directly.
 */
export function formatGroupContextBlock(
	messages: ThreadContextMessage[],
	event: InboundGroupMentionEvent,
): string {
	const where = event.channelName ? `the ${event.channelName} channel` : 'the channel';
	const lines = messages.map((m) => {
		const stamp = m.timestamp ? ` (${m.timestamp})` : '';
		return `${m.sender}${stamp}: ${m.text}`;
	});
	return [
		'## Channel context',
		`Recent history of ${where} where you were mentioned, fetched live from the platform for THIS reply only. It is ephemeral background — not part of your stored conversation — and will be re-fetched fresh next time.`,
		lines.join('\n\n'),
	].join('\n\n');
}

/**
 * Title for a coworker conversation, set at creation (these threads skip
 * auto-title and never appear in the web switcher — the title is for the DB and
 * debugging). Capped to the stored-title budget.
 */
export function coworkerConversationTitle(event: InboundGroupMentionEvent): string {
	const base = event.channelName ?? `${event.externalThreadId}`;
	return base.length > 60 ? base.slice(0, 60) : base;
}

/**
 * The coworker-mode ingest path — the second, deliberately separate entry point
 * beside `ingestInboundEvent` (which stays DM/assistant-only). A group @-mention of
 * the bot flows here from a group-capable adapter's transport.
 *
 * Authorization model: **the channel invite is the authorization.** The bot only
 * receives events from channels a workspace admin invited it to, and anyone in
 * such a channel may mention it — there is no per-user identity-link gate here.
 * An identity link, when one exists, only enriches attribution (ties the message
 * to a Hezo user); its absence changes nothing.
 */
export async function ingestGroupMentionEvent(
	deps: IngestDeps,
	adapter: ChatChannelAdapter,
	event: InboundGroupMentionEvent,
): Promise<void> {
	// Defense in depth — transports check before emitting, but a queued event can
	// race a config change.
	const supported = await adapter.supportsGroupMode?.().catch(() => false);
	if (!supported) {
		log.info(`ignoring ${adapter.channel} group mention: group mode not active`);
		return;
	}

	const authorUserId = await resolveLinkedUser(deps.db, adapter.channel, event.externalUserId);

	// Ephemeral platform history for this one turn: context that rode in with the
	// event (a reply-quote hop) ahead of fetched/observed history. Best-effort: a
	// fetch failure degrades to answering from the mention text alone, never
	// drops the turn.
	let context: ThreadContextMessage[] = [...(event.inlineContext ?? [])];
	if (adapter.fetchThreadContext) {
		try {
			context = [...(await adapter.fetchThreadContext(event)), ...context];
		} catch (e) {
			log.warn(`fetching ${adapter.channel} thread context failed; replying without it`, e);
		}
	}

	await deps.manager.sendTurn({
		text: event.text,
		channel: adapter.channel,
		externalThreadId: event.externalThreadId,
		authorUserId,
		kind: ChatConversationKind.Coworker,
		authorLabel: event.senderDisplayName ?? event.externalHandle ?? event.externalUserId,
		injectedContext: context.length > 0 ? formatGroupContextBlock(context, event) : undefined,
		title: coworkerConversationTitle(event),
	});
}
