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

/**
 * Which conversation the dock is showing. Chat lives in rooms, not routes
 * (decision: there is no dedicated chat page):
 *
 * - `ceo` — the CEO's single live stream (the server resolves it; HQ scope).
 * - `thread` — a specific CEO-scope conversation by id: a History thread, an
 *   external DM, or a read-only team channel.
 * - `agent` — a project agent's DM, addressed by project + agent slug the way
 *   every project surface is.
 */
export type ChatRoom =
	| { kind: 'ceo' }
	| { kind: 'thread'; id: string }
	| { kind: 'agent'; projectSlug: string; agentSlug: string; title: string };

export const CEO_ROOM: ChatRoom = { kind: 'ceo' };

/** Stable identity key for a room — query keys, queue buckets, persistence. */
export function chatRoomKey(room: ChatRoom): string {
	if (room.kind === 'ceo') return 'ceo';
	if (room.kind === 'thread') return `thread:${room.id}`;
	return `agent:${room.projectSlug}:${room.agentSlug}`;
}

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
	/** The replying agent, on assistant rows — drives the author label. */
	author_member_id?: string | null;
	/** Up to three one-tap replies the agent offered with this reply. */
	suggested_replies?: string[] | null;
}

interface ConversationData {
	conversation_id: string | null;
	messages: ChatMessage[];
	/** How many older messages have been compacted into long-term memory. */
	compacted_count: number;
}

/**
 * A message parked while the agent is mid-reply. It has not reached the server,
 * so it can still be pulled back out; the whole queue flushes as one turn the
 * moment the reply settles.
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

/** Stable identity for "no queue" so it never re-triggers effects. */
const EMPTY_QUEUE: readonly QueuedChatMessage[] = Object.freeze([]);

let queuedMessageSeq = 0;
const nextQueuedMessageId = () => `queued-${++queuedMessageSeq}`;

/**
 * Unread badge state for the header's CEO monogram. The count survives reloads
 * in localStorage (mirrors the `hezo_token` convention); opening the chat
 * clears it. HQ-scoped by construction: the `chat:global` room this rides only
 * carries HQ/CEO events now — a project DM signals on its team's room and
 * badges through the server-side watermark instead.
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
 * The CEO-reply unread tally for the header monogram. Lives beside the widget
 * rather than inside `useChat` because its one consumer — the header badge —
 * renders whether or not the dock is mounted open. Joins the global HQ room
 * for its lifetime; a completed CEO reply while the dock is closed bumps it,
 * opening the dock clears it.
 */
export function useCeoUnread(chatOpen: boolean): number {
	const { subscribe, joinRoom, leaveRoom } = useSocket();
	const [unread, setUnread] = useState<number>(readStoredUnread);
	const openRef = useRef(chatOpen);
	useEffect(() => {
		openRef.current = chatOpen;
		if (chatOpen) {
			setUnread(0);
			writeStoredUnread(0);
		}
	}, [chatOpen]);
	useEffect(() => {
		const room = wsRoom.chat();
		joinRoom(room);
		return () => leaveRoom(room);
	}, [joinRoom, leaveRoom]);
	useEffect(() => {
		return subscribe(WsMessageType.ChatMessageComplete, (raw) => {
			const m = raw as WsChatMessageCompleteMessage;
			if (m.status !== ChatMessageStatus.Complete || openRef.current) return;
			setUnread((n) => {
				const next = n + 1;
				writeStoredUnread(next);
				return next;
			});
		});
	}, [subscribe]);
	return unread;
}

/**
 * The room the operator last had open, restored on the next mount (same
 * localStorage convention as the unread tally). Selecting the CEO clears the
 * key so an untouched dock keeps the default behaviour.
 */
const CHAT_ROOM_KEY = 'hezo_chat_room';

export function readStoredRoom(): ChatRoom | undefined {
	try {
		const raw = localStorage.getItem(CHAT_ROOM_KEY);
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as ChatRoom;
		if (parsed && (parsed.kind === 'thread' || parsed.kind === 'agent')) return parsed;
		return undefined;
	} catch {
		return undefined;
	}
}

export function writeStoredRoom(room: ChatRoom | undefined): void {
	try {
		if (room && room.kind !== 'ceo') localStorage.setItem(CHAT_ROOM_KEY, JSON.stringify(room));
		else localStorage.removeItem(CHAT_ROOM_KEY);
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

/** A CEO-scope conversation in the switcher (live, external, channel, History). */
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
	/** Set when the thread was converted into a task (readable History). */
	converted_task_id: string | null;
	/** Joined reference; null when not converted or the task was since deleted. */
	converted_task: ChatConvertedTaskRef | null;
}

/** One agent DM row in a project's room list (menu cards + dock switcher). */
export interface ProjectChatRoomSummary {
	member_id: string;
	slug: string;
	title: string;
	display_name: string;
	conversation_id: string | null;
	last_activity_at: string | null;
	last_message_id: string | null;
	last_message_preview: string | null;
	last_message_role: string | null;
	unread: boolean;
}

/**
 * The CEO-scope conversation list: the live stream, external DMs, team
 * channels, and closed threads (History). Refetched on conversation-updated
 * broadcasts from the global HQ room.
 */
export function useChatConversations(active: boolean) {
	const queryClient = useQueryClient();
	const { subscribe } = useSocket();
	const query = useQuery({
		queryKey: queryKeys.chatConversations(),
		queryFn: () =>
			api.get<{ conversations: ChatConversationSummary[] }>(
				'/api/chat/conversations?include_closed=true',
			),
		enabled: active,
	});
	useEffect(() => {
		if (!active) return;
		return subscribe(WsMessageType.ChatConversationUpdated, () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.chatConversations() });
		});
	}, [active, subscribe, queryClient]);
	return {
		conversations: query.data?.conversations ?? [],
		loaded: !query.isPending,
	};
}

/**
 * A project's DM room list: one row per enabled roster agent, with the unread
 * bit computed server-side from the reads watermark. Drives the project menu's
 * chat cards and the dock switcher's project section. Kept live by boundary
 * events on the conversations' own rooms (the open dock) and refetch-on-open.
 */
export function useProjectChatRooms(projectSlug: string | null | undefined, active: boolean) {
	const queryClient = useQueryClient();
	const { subscribe } = useSocket();
	const enabled = !!projectSlug && active;
	const query = useQuery({
		queryKey: queryKeys.projectChatRooms(projectSlug ?? ''),
		queryFn: () =>
			api.get<{ conversations: ProjectChatRoomSummary[] }>(
				`/api/projects/${projectSlug}/chat/conversations`,
			),
		enabled,
	});
	// Any boundary event for one of this project's conversations changes its
	// ordering, preview or unread state — refetch the list. The events arrive on
	// rooms other surfaces already hold open (the conversation's own room, the
	// team signal room the sidebar joins).
	useEffect(() => {
		if (!enabled) return;
		const invalidate = () =>
			queryClient.invalidateQueries({ queryKey: queryKeys.projectChatRooms(projectSlug ?? '') });
		const offStart = subscribe(WsMessageType.ChatMessageStart, invalidate);
		const offComplete = subscribe(WsMessageType.ChatMessageComplete, invalidate);
		return () => {
			offStart();
			offComplete();
		};
	}, [enabled, projectSlug, subscribe, queryClient]);
	return {
		rooms: query.data?.conversations ?? [],
		loaded: !query.isPending,
	};
}

function conversationUrl(room: ChatRoom): string {
	if (room.kind === 'agent') {
		return `/api/projects/${encodeURIComponent(room.projectSlug)}/chat/agents/${encodeURIComponent(room.agentSlug)}/conversation`;
	}
	if (room.kind === 'thread') {
		return `/api/chat/conversation?conversation_id=${encodeURIComponent(room.id)}`;
	}
	return '/api/chat/conversation';
}

function roomQueryKey(room: ChatRoom): readonly unknown[] {
	return room.kind === 'agent'
		? queryKeys.agentChatRoom(room.projectSlug, room.agentSlug)
		: queryKeys.chatConversation(room.kind === 'thread' ? room.id : undefined);
}

/**
 * Drives one chat room. The TanStack Query cache is the source of truth for
 * messages (keyed per room); the initial history loads via `useQuery` and
 * streamed start/delta/complete events are folded into the same cache entry via
 * `setQueryData`. Events carry their `conversationId`, so another room's stream
 * never lands here. The query never refetches on its own (`staleTime:
 * Infinity`) so an in-flight reply's accumulated deltas aren't clobbered by a
 * server snapshot that only persists on completion.
 */
export function useChat(active: boolean, room: ChatRoom = CEO_ROOM) {
	const { subscribe, joinRoom, leaveRoom } = useSocket();
	const queryClient = useQueryClient();
	// The server-resolved id of the conversation this hook is showing. Used to
	// filter WS events so another room's stream never lands in this cache entry.
	const resolvedIdRef = useRef<string | null>(room.kind === 'thread' ? room.id : null);
	// In-flight send: the user's messages are shown optimistically (with a pending
	// assistant placeholder) while the server warms the container, so the operator
	// gets immediate feedback instead of a blank. Cleared when the real user
	// message arrives over WS, or when the send settles (incl. failure). It's a
	// list because a flushed queue sends several messages as one turn.
	const [pending, setPending] = useState<{
		at: string;
		messages: OutboundChatMessage[];
	} | null>(null);
	// Messages parked while a reply streams, bucketed per room so switching rooms
	// (or closing the panel) never drops or misdelivers a queued message.
	const [queues, setQueues] = useState<Record<string, QueuedChatMessage[]>>({});
	// The tool the in-flight reply last reached for, if any. Transient.
	const [toolActivity, setToolActivity] = useState<{ messageId: string; tool: string } | null>(
		null,
	);
	const queueKey = chatRoomKey(room);
	const queue = queues[queueKey] ?? EMPTY_QUEUE;
	const queryKey = roomQueryKey(room);

	const query = useQuery({
		queryKey,
		queryFn: () => api.get<ConversationData>(conversationUrl(room)),
		enabled: active,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	// Track the server-resolved conversation id so WS events can be filtered.
	resolvedIdRef.current = query.data?.conversation_id ?? (room.kind === 'thread' ? room.id : null);

	// Join the resolved conversation's own room: streaming deltas go ONLY there
	// (signal rooms carry boundary events for lists and badges), so an open room
	// without this subscription would render replies only on completion.
	const resolvedConversationId = query.data?.conversation_id ?? null;
	useEffect(() => {
		if (!resolvedConversationId) return;
		const r = wsRoom.chatConversation(resolvedConversationId);
		joinRoom(r);
		return () => leaveRoom(r);
	}, [joinRoom, leaveRoom, resolvedConversationId]);

	// Server-side read watermark: while the room is open, the newest message is
	// what the operator has seen. Written only when the tail actually moves, and
	// never for the operator's own just-sent message (their bubble is not
	// "unread" anywhere). Fire-and-forget — a failed mark costs a stale badge.
	const lastMarkedRef = useRef<string | null>(null);
	const serverMessagesForMark = query.data?.messages;
	useEffect(() => {
		if (!active || !resolvedConversationId || !serverMessagesForMark?.length) return;
		const tail = serverMessagesForMark[serverMessagesForMark.length - 1];
		if (!tail || tail.id.startsWith('optimistic-') || lastMarkedRef.current === tail.id) return;
		lastMarkedRef.current = tail.id;
		api
			.post(`/api/chat/conversations/${resolvedConversationId}/read`, {
				last_read_message_id: tail.id,
			})
			.catch(() => undefined);
	}, [active, resolvedConversationId, serverMessagesForMark]);

	// queryKey is derived from the room; the string key is the stable identity.
	// biome-ignore lint/correctness/useExhaustiveDependencies: queryKey identity is the room key
	useEffect(() => {
		const patch = (fn: (messages: ChatMessage[]) => ChatMessage[]) => {
			queryClient.setQueryData<ConversationData>(queryKey, (prev) =>
				prev ? { ...prev, messages: fn(prev.messages) } : prev,
			);
		};
		// A message belongs to this room when its conversationId matches the
		// resolved id. A room that has no conversation yet (a fresh agent DM)
		// accepts the first events unfiltered — its conversation is being created
		// by this very send, and the refetch below re-anchors the id.
		const forThisRoom = (cid?: string): boolean =>
			!cid || !resolvedIdRef.current || cid === resolvedIdRef.current;
		const offStart = subscribe(WsMessageType.ChatMessageStart, (raw) => {
			const m = raw as WsChatMessageStartMessage;
			if (!forThisRoom(m.conversationId)) return;
			// The real user message landed — drop the optimistic placeholder so the
			// server rows (user + streaming assistant) take over without duplicating.
			if (m.role === 'user') setPending(null);
			// A fresh DM's first send creates its conversation server-side; anchor
			// the cache to it so later events filter correctly.
			queryClient.setQueryData<ConversationData>(queryKey, (prev) =>
				prev && prev.conversation_id === null
					? { ...prev, conversation_id: m.conversationId }
					: prev,
			);
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
								author_member_id: m.authorMemberId ?? null,
							},
						],
			);
		});
		const offDelta = subscribe(WsMessageType.ChatMessageDelta, (raw) => {
			const m = raw as WsChatMessageDeltaMessage;
			if (!forThisRoom(m.conversationId)) return;
			patch((messages) =>
				messages.map((x) => (x.id === m.messageId ? { ...x, content: x.content + m.text } : x)),
			);
		});
		// Transient: the last tool the agent reached for on the in-flight reply.
		const offToolActivity = subscribe(WsMessageType.ChatMessageToolActivity, (raw) => {
			const m = raw as WsChatMessageToolActivityMessage;
			if (!forThisRoom(m.conversationId)) return;
			setToolActivity({ messageId: m.messageId, tool: m.tool });
		});
		const offComplete = subscribe(WsMessageType.ChatMessageComplete, (raw) => {
			const m = raw as WsChatMessageCompleteMessage;
			if (!forThisRoom(m.conversationId)) return;
			patch((messages) =>
				messages.map((x) =>
					x.id === m.messageId
						? {
								...x,
								content: m.content,
								status: m.status,
								error: m.error,
								suggested_replies: m.suggestedReplies ?? null,
							}
						: x,
				),
			);
			setToolActivity((prev) => (prev?.messageId === m.messageId ? null : prev));
		});
		// Older messages were compacted into long-term memory and evicted.
		const offCompacted = subscribe(WsMessageType.ChatCompacted, (raw) => {
			const m = raw as { conversationId?: string };
			if (!forThisRoom(m.conversationId)) return;
			queryClient.invalidateQueries({ queryKey });
		});
		return () => {
			offStart();
			offDelta();
			offToolActivity();
			offComplete();
			offCompacted();
		};
	}, [subscribe, queryClient, queueKey]);

	const sendMutation = useMutation({
		// Always the batch shape: one turn carries N user messages, so a flushed
		// queue posts each as its own bubble and a single reply answers all of them.
		mutationFn: (batch: OutboundChatMessage[]) => {
			const body = {
				messages: batch.map((m) => ({
					text: m.text,
					attachment_ids: m.attachments.map((a) => a.id),
				})),
			};
			if (room.kind === 'agent') {
				return api.post(
					`/api/projects/${encodeURIComponent(room.projectSlug)}/chat/agents/${encodeURIComponent(room.agentSlug)}/messages`,
					body,
				);
			}
			return api.post('/api/chat/messages', {
				...body,
				...(room.kind === 'thread' ? { conversation_id: room.id } : {}),
			});
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to send message');
		},
		// Clear the optimistic placeholder once the request settles — on success the
		// WS user-message event has already cleared it; on failure this drops the
		// unsent bubble.
		onSettled: () => setPending(null),
	});

	const serverMessages = query.data?.messages ?? [];
	// Append the optimistic user bubbles + a pending assistant "thinking"
	// placeholder while a send is in flight.
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
	 * Post immediately. While a reply is streaming the server aborts it (keeping
	 * the partial as `interrupted`) and starts a fresh turn — that's the interrupt.
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

	// Flush the queue as one turn the moment the room goes idle — after a reply
	// completes, fails, or is interrupted, so a parked message is never lost to a
	// turn that went wrong.
	const flushingRef = useRef(false);
	useEffect(() => {
		if (streaming || sending || queue.length === 0 || flushingRef.current) return;
		flushingRef.current = true;
		setQueues((prev) => ({ ...prev, [queueKey]: [] }));
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
		// Only while that message is still streaming: a settled reply clears it.
		toolActivity:
			toolActivity &&
			messages.some(
				(m) => m.id === toolActivity.messageId && m.status === ChatMessageStatus.Streaming,
			)
				? toolActivity.tool
				: null,
		loaded: !query.isPending,
		// Messages parked for the next turn, plus the two ways to change that queue.
		queue,
		enqueue,
		dequeue,
		// The server-resolved id of the active conversation (null for a fresh DM
		// that has never been written to).
		conversationId: query.data?.conversation_id ?? undefined,
		// >0 once older messages have been compacted into long-term memory.
		compactedCount: query.data?.compacted_count ?? 0,
	};
}
