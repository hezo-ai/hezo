import {
	type ChatChannel,
	type ChatConversationKind,
	type ChatMessageRole,
	ChatMessageStatus,
	type ChatSystemMessageKind,
	type WsChatMessageCompleteMessage,
	type WsChatMessageDeltaMessage,
	type WsChatMessageStartMessage,
	type WsChatMessageToolActivityMessage,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '../contexts/socket-context';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import type { CommentAttachment } from './use-comments';
import { toast } from './use-toast';

export interface ChatMessage {
	id: string;
	role: ChatMessageRole;
	channel: ChatChannel;
	status: ChatMessageStatus;
	content: string;
	created_at: string;
	/** Files sent with the message, rendered as chips under the bubble. */
	attachments?: CommentAttachment[];
	/** Set on a `system` row: which marker it is. Drives how the row renders. */
	system_kind?: ChatSystemMessageKind | null;
	/** Why a failed reply failed, in the server's words. */
	error?: string | null;
}

interface ConversationData {
	conversation_id: string;
	messages: ChatMessage[];
	/** How many older messages have been compacted into long-term memory. */
	compacted_count: number;
}

/**
 * A message parked while the CEO is mid-reply. It has not reached the server, so
 * it can still be pulled back out; the whole queue flushes as one turn the moment
 * the reply settles.
 */
export interface QueuedChatMessage {
	id: string;
	text: string;
	attachments: CommentAttachment[];
}

/** One message on its way to the server (a send in flight). */
interface OutboundChatMessage {
	text: string;
	attachments: CommentAttachment[];
}

/** Queue bucket for the default web thread, which has no caller-supplied id. */
const DEFAULT_THREAD_QUEUE_KEY = '__default__';

/** Stable identity for "no queue" so it never re-triggers effects. */
const EMPTY_QUEUE: readonly QueuedChatMessage[] = Object.freeze([]);

let queuedMessageSeq = 0;
const nextQueuedMessageId = () => `queued-${++queuedMessageSeq}`;

/**
 * Unread badge state for the minimized launcher. The CEO conversation has no
 * server-side read tracking, so we count completed CEO replies that land while
 * the widget is closed and persist the tally in localStorage (mirrors the
 * `hezo_token` convention) so a reload still shows the indicator. Opening the
 * chat clears it. The overlay itself reuses the same component as the inbox.
 */
const CHAT_UNREAD_KEY = 'hezo_chat_unread';

function readStoredUnread(): number {
	try {
		const n = Number.parseInt(localStorage.getItem(CHAT_UNREAD_KEY) ?? '', 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

function writeStoredUnread(count: number): void {
	try {
		if (count > 0) localStorage.setItem(CHAT_UNREAD_KEY, String(count));
		else localStorage.removeItem(CHAT_UNREAD_KEY);
	} catch {
		// localStorage may be unavailable (private mode); the badge just won't persist.
	}
}

/**
 * The thread the operator last switched to in the chatbox (same localStorage
 * convention as the unread tally above). The widget restores it on mount, so
 * closing and reopening — or a reload, or the remount a bare route forces —
 * comes back to that conversation instead of snapping to the server's default
 * web thread. Only an *explicit* switch is recorded, and returning to the default
 * clears the key, so an operator who never touches the switcher keeps exactly the
 * old behaviour. A stored id is discarded once the thread list shows it is no
 * longer open.
 */
const CHAT_THREAD_KEY = 'hezo_chat_thread';

export function readStoredThreadId(): string | undefined {
	try {
		return localStorage.getItem(CHAT_THREAD_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

export function writeStoredThreadId(id: string | undefined): void {
	try {
		if (id) localStorage.setItem(CHAT_THREAD_KEY, id);
		else localStorage.removeItem(CHAT_THREAD_KEY);
	} catch {
		// localStorage may be unavailable (private mode); the selection just won't persist.
	}
}

/** The task a converted thread became — drives the meta message and banner link. */
export interface ChatConvertedTaskRef {
	id: string;
	identifier: string;
	title: string;
	project_slug: string;
}

/** A conversation thread in the switcher list. */
export interface ChatConversationSummary {
	id: string;
	/** The thread's one home surface (web, telegram, slack, discord, …). */
	channel: ChatChannel;
	external_thread_id: string | null;
	/** 'assistant' = your own thread (interactive); 'coworker' = a team channel (read-only here). */
	kind: ChatConversationKind;
	title: string | null;
	last_activity_at: string;
	closed_at: string | null;
	/** Set when the thread was converted into a task (it stays listed, read-only). */
	converted_task_id: string | null;
	/** Joined reference; null when not converted or the task was since deleted. */
	converted_task: ChatConvertedTaskRef | null;
}

/**
 * List the CEO chat conversation threads (open only) and expose create/close
 * mutations for the switcher. Invalidated on new activity via the global room.
 */
export function useChatConversations(active: boolean) {
	const queryClient = useQueryClient();
	const { subscribe } = useSocket();
	const query = useQuery({
		queryKey: queryKeys.chatConversations(),
		queryFn: () => api.get<{ conversations: ChatConversationSummary[] }>('/api/chat/conversations'),
		enabled: active,
	});
	// A thread's title can change server-side (the CEO auto-titles an untitled thread
	// from its first message, in parallel with the reply — so it can land while the
	// reply is still streaming). Refetch the list when that broadcast arrives so the
	// switcher/rail label updates live. The widget's `useChat` already joins the
	// `chat:global` room for its lifetime, so the broadcast reaches us without a separate join here.
	useEffect(() => {
		if (!active) return;
		return subscribe(WsMessageType.ChatConversationUpdated, () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.chatConversations() });
		});
	}, [active, subscribe, queryClient]);
	const create = useMutation({
		mutationFn: (title?: string) =>
			api.post<{ conversation: ChatConversationSummary }>('/api/chat/conversations', { title }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chatConversations() }),
		onError: (e: { message?: string }) => toast.error(e?.message ?? 'Failed to create thread'),
	});
	const close = useMutation({
		mutationFn: (id: string) => api.post(`/api/chat/conversations/${id}/close`, {}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chatConversations() }),
		onError: (e: { message?: string }) => toast.error(e?.message ?? 'Failed to close thread'),
	});
	// Invalidate + refetch, not optimistic: the server creates the task, writes
	// the meta message, and closes the thread in one go — the UI must only ever
	// show that state as read back. Both keys matter: the list carries the
	// converted flag, and the conversation query (staleTime: Infinity) needs the
	// invalidation to pull in the system meta message for tabs that missed the
	// WebSocket event. No success toast — the in-thread meta message is the
	// confirmation.
	const convert = useMutation({
		mutationFn: (input: { id: string; projectId: string; title?: string }) =>
			api.post<{
				task: ChatConvertedTaskRef;
				conversation: ChatConversationSummary;
			}>(`/api/chat/conversations/${input.id}/convert-to-task`, {
				project_id: input.projectId,
				title: input.title,
			}),
		onSuccess: (_data, input) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.chatConversations() });
			queryClient.invalidateQueries({ queryKey: queryKeys.chatConversation(input.id) });
		},
	});
	return {
		conversations: query.data?.conversations ?? [],
		loaded: !query.isPending,
		createThread: (title?: string) => create.mutateAsync(title),
		closeThread: (id: string) => close.mutateAsync(id),
		convertThread: (input: { id: string; projectId: string; title?: string }) =>
			convert.mutateAsync(input),
		converting: convert.isPending,
	};
}

/**
 * Drives one CEO chat conversation thread (the default web thread when
 * `conversationId` is omitted). The TanStack Query cache is the source of truth
 * for messages (keyed by {@link queryKeys.chatConversation} + the thread id); the
 * initial history loads via `useQuery` and streamed start/delta/complete events
 * are folded into the same cache entry via `setQueryData`. Events carry their
 * `conversationId`, so a message for another thread is ignored. The query never
 * refetches on its own (`staleTime: Infinity`) so an in-flight reply's accumulated
 * deltas aren't clobbered by a server snapshot that only persists on completion.
 */
export function useChat(active: boolean, conversationId?: string) {
	const { subscribe, joinRoom, leaveRoom } = useSocket();
	const queryClient = useQueryClient();
	const [unread, setUnread] = useState<number>(readStoredUnread);
	// The server-resolved id of the thread this hook is showing (the default web
	// thread resolves to a concrete id in the query response). Used to filter WS
	// events so another thread's stream never lands in this cache entry.
	const resolvedIdRef = useRef<string | null>(conversationId ?? null);
	// In-flight send: the user's messages are shown optimistically (with a pending
	// assistant placeholder) while the server warms the session / egress check, so
	// the operator gets immediate feedback instead of a ~10s blank. Cleared when the
	// real user message arrives over WS, or when the send settles (incl. failure).
	// It's a list because a flushed queue sends several messages as one turn.
	const [pending, setPending] = useState<{
		at: string;
		messages: OutboundChatMessage[];
	} | null>(null);
	// Messages parked while a reply streams, bucketed per thread so switching
	// threads (or closing the panel) never drops or misdelivers a queued message.
	// Client-side only: a reload loses the queue, which is the accepted cost of not
	// making a parked message a `chat_messages` row + migration.
	const [queues, setQueues] = useState<Record<string, QueuedChatMessage[]>>({});
	// The tool the in-flight reply last reached for, if any. Transient — see the
	// subscription below.
	const [toolActivity, setToolActivity] = useState<{ messageId: string; tool: string } | null>(
		null,
	);
	const queueKey = conversationId ?? DEFAULT_THREAD_QUEUE_KEY;
	const queue = queues[queueKey] ?? EMPTY_QUEUE;
	// The socket handler is wired once; this ref lets it read the live open state
	// (whether the chat is currently visible) without re-subscribing every toggle.
	const activeRef = useRef(active);
	useEffect(() => {
		activeRef.current = active;
	}, [active]);

	const query = useQuery({
		queryKey: queryKeys.chatConversation(conversationId),
		queryFn: () =>
			api.get<ConversationData>(
				conversationId
					? `/api/chat/conversation?conversation_id=${encodeURIComponent(conversationId)}`
					: '/api/chat/conversation',
			),
		enabled: active,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	// Track the server-resolved thread id so WS events can be filtered to this thread.
	resolvedIdRef.current = query.data?.conversation_id ?? conversationId ?? null;

	// Opening the chat means the operator is reading it — drop the unread badge.
	useEffect(() => {
		if (!active) return;
		setUnread(0);
		writeStoredUnread(0);
	}, [active]);

	// Join the global CEO room for the widget's whole lifetime (it's mounted
	// app-wide), not just while open, so a reply badges the launcher even when the
	// chat is minimized. Cache patches below are no-ops until history has loaded.
	useEffect(() => {
		const room = wsRoom.chat();
		joinRoom(room);
		return () => leaveRoom(room);
	}, [joinRoom, leaveRoom]);

	useEffect(() => {
		const patch = (fn: (messages: ChatMessage[]) => ChatMessage[]) => {
			queryClient.setQueryData<ConversationData>(
				queryKeys.chatConversation(conversationId),
				(prev) => (prev ? { ...prev, messages: fn(prev.messages) } : prev),
			);
		};
		// A message belongs to this thread when its conversationId matches the
		// resolved id (or either side is absent — back-compat / pre-resolution).
		const forThisThread = (cid?: string): boolean =>
			!cid || !resolvedIdRef.current || cid === resolvedIdRef.current;
		const offStart = subscribe(WsMessageType.ChatMessageStart, (raw) => {
			const m = raw as WsChatMessageStartMessage;
			if (!forThisThread(m.conversationId)) return;
			// The real user message landed — drop the optimistic placeholder so the
			// server rows (user + streaming assistant) take over without duplicating.
			if (m.role === 'user') setPending(null);
			patch((messages) =>
				messages.some((x) => x.id === m.messageId)
					? messages
					: [
							...messages,
							{
								id: m.messageId,
								role: m.role,
								channel: m.channel,
								status: (m.role === 'assistant' ? 'streaming' : 'complete') as ChatMessageStatus,
								content: m.content,
								created_at: m.createdAt,
								attachments: m.attachments,
								system_kind: m.systemKind,
							},
						],
			);
		});
		const offDelta = subscribe(WsMessageType.ChatMessageDelta, (raw) => {
			const m = raw as WsChatMessageDeltaMessage;
			if (!forThisThread(m.conversationId)) return;
			patch((messages) =>
				messages.map((x) => (x.id === m.messageId ? { ...x, content: x.content + m.text } : x)),
			);
		});
		// Transient: the last tool the CEO reached for on the in-flight reply, shown
		// beside the dots and dropped when the reply settles. Deliberately not part
		// of the message cache — it is progress, not conversation, and persisting it
		// would leave a stale "Using ..." on a reloaded thread.
		const offToolActivity = subscribe(WsMessageType.ChatMessageToolActivity, (raw) => {
			const m = raw as WsChatMessageToolActivityMessage;
			if (!forThisThread(m.conversationId)) return;
			setToolActivity({ messageId: m.messageId, tool: m.tool });
		});
		const offComplete = subscribe(WsMessageType.ChatMessageComplete, (raw) => {
			const m = raw as WsChatMessageCompleteMessage;
			if (!forThisThread(m.conversationId)) return;
			patch((messages) =>
				messages.map((x) =>
					x.id === m.messageId ? { ...x, content: m.content, status: m.status, error: m.error } : x,
				),
			);
			setToolActivity((prev) => (prev?.messageId === m.messageId ? null : prev));
			// Complete events fire only for assistant replies. One that finishes
			// while the widget is closed is an unread CEO message → badge the launcher.
			if (m.status === ChatMessageStatus.Complete && !activeRef.current) {
				setUnread((n) => {
					const next = n + 1;
					writeStoredUnread(next);
					return next;
				});
			}
		});
		// Older messages were compacted into long-term memory and evicted. Refetch
		// the conversation so the chatbox drops them (leaving the retained tail) and
		// picks up the new compacted_count that drives the "chat compacted" marker.
		const offCompacted = subscribe(WsMessageType.ChatCompacted, (raw) => {
			const m = raw as { conversationId?: string };
			if (!forThisThread(m.conversationId)) return;
			queryClient.invalidateQueries({ queryKey: queryKeys.chatConversation(conversationId) });
		});
		return () => {
			offStart();
			offDelta();
			offToolActivity();
			offComplete();
			offCompacted();
		};
	}, [subscribe, queryClient, conversationId]);

	const sendMutation = useMutation({
		// Always the batch shape: one turn carries N user messages, so a flushed
		// queue posts each as its own bubble and a single reply answers all of them.
		mutationFn: (batch: OutboundChatMessage[]) =>
			api.post('/api/chat/messages', {
				messages: batch.map((m) => ({
					text: m.text,
					attachment_ids: m.attachments.map((a) => a.id),
				})),
				...(conversationId ? { conversation_id: conversationId } : {}),
			}),
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to send message to the CEO');
		},
		// Clear the optimistic placeholder once the request settles — on success the
		// WS user-message event has already cleared it; on failure (e.g. egress gate
		// reject, toasted above) this drops the unsent bubble.
		onSettled: () => setPending(null),
	});

	const serverMessages = query.data?.messages ?? [];
	// Append the optimistic user bubbles + a pending assistant "thinking" placeholder
	// while a send is in flight (an assistant row with empty streaming content renders
	// the existing typing indicator). They're dropped the moment the real rows arrive.
	const messages: ChatMessage[] =
		pending !== null
			? [
					...serverMessages,
					...pending.messages.map((m, i) => ({
						id: `optimistic-user-${i}`,
						role: 'user' as ChatMessageRole,
						channel: 'web' as ChatChannel,
						status: 'complete' as ChatMessageStatus,
						content: m.text,
						created_at: pending.at,
						attachments: m.attachments,
					})),
					{
						id: 'optimistic-assistant',
						role: 'assistant' as ChatMessageRole,
						channel: 'web' as ChatChannel,
						status: 'streaming' as ChatMessageStatus,
						content: '',
						created_at: pending.at,
					},
				]
			: serverMessages;
	const streaming = messages.some((m) => m.role === 'assistant' && m.status === 'streaming');
	const sending = pending !== null;

	// Stable across renders so the flush effect below can depend on it honestly
	// rather than suppressing the dependency.
	const { mutateAsync } = sendMutation;
	const sendBatch = useCallback(
		(batch: OutboundChatMessage[]) => {
			if (batch.length === 0) return Promise.resolve();
			setPending({ at: new Date().toISOString(), messages: batch });
			return mutateAsync(batch);
		},
		[mutateAsync],
	);

	/**
	 * Post immediately. While a reply is streaming the server aborts it (keeping the
	 * partial as `interrupted`) and starts a fresh turn — that's the interrupt.
	 */
	const send = (text: string, attachments: CommentAttachment[] = []) => {
		const trimmed = text.trim();
		if (!trimmed && attachments.length === 0) return Promise.resolve();
		return sendBatch([{ text: trimmed, attachments }]);
	};

	/** Park a message for the next turn. Nothing has reached the server yet. */
	const enqueue = (text: string, attachments: CommentAttachment[] = []) => {
		const trimmed = text.trim();
		if (!trimmed && attachments.length === 0) return;
		setQueues((prev) => ({
			...prev,
			[queueKey]: [
				...(prev[queueKey] ?? []),
				{ id: nextQueuedMessageId(), text: trimmed, attachments },
			],
		}));
	};

	/** Pull a message back out. Only possible before the queue has been dispatched. */
	const dequeue = (id: string) => {
		setQueues((prev) => ({
			...prev,
			[queueKey]: (prev[queueKey] ?? []).filter((m) => m.id !== id),
		}));
	};

	// Flush the queue as one turn the moment the thread goes idle — after a reply
	// completes, fails, or is interrupted, so a parked message is never lost to a
	// turn that went wrong. The ref guards the window between clearing the queue and
	// `pending` landing, where this effect would otherwise re-enter and double-post.
	const flushingRef = useRef(false);
	useEffect(() => {
		if (streaming || sending || queue.length === 0 || flushingRef.current) return;
		flushingRef.current = true;
		setQueues((prev) => ({ ...prev, [queueKey]: [] }));
		// A rejected flush is already surfaced by the mutation's `onError` toast;
		// swallow it here so it doesn't surface again as an unhandled rejection.
		sendBatch(queue.map((m) => ({ text: m.text, attachments: m.attachments })))
			.catch(() => undefined)
			.finally(() => {
				flushingRef.current = false;
			});
	}, [streaming, sending, queue, queueKey, sendBatch]);

	return {
		messages,
		send,
		streaming,
		sending,
		// Only while that message is still streaming: a settled reply clears it, and
		// a stale id from a superseded turn must not label the new one.
		toolActivity:
			toolActivity &&
			messages.some(
				(m) => m.id === toolActivity.messageId && m.status === ChatMessageStatus.Streaming,
			)
				? toolActivity.tool
				: null,
		loaded: !query.isPending,
		unread,
		// Messages parked for the next turn, plus the two ways to change that queue.
		queue,
		enqueue,
		dequeue,
		// The server-resolved id of the active thread (the default web thread when
		// no id was passed) — drives the switcher's selected value.
		conversationId: query.data?.conversation_id,
		// >0 once older messages have been compacted into long-term memory; drives
		// the "chat compacted" marker at the top of the window.
		compactedCount: query.data?.compacted_count ?? 0,
	};
}
