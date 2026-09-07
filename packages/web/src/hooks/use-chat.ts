import {
	type ChatChannel,
	type ChatConversationKind,
	type ChatMessageRole,
	ChatMessageStatus,
	type ChatSystemMessageKind,
	type WsChatGroupPendingTurn,
	type WsChatGroupPendingTurnsMessage,
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
 * - `group` — a project group room (several agents, mention-driven turns).
 *   Rooms have no slug, so the conversation id is their identity.
 */
export type ChatRoom =
	| { kind: 'ceo' }
	| { kind: 'thread'; id: string }
	| { kind: 'agent'; projectSlug: string; agentSlug: string; title: string }
	| {
			kind: 'group';
			projectSlug: string;
			conversationId: string;
			title: string;
			isGeneral?: boolean;
	  };

export const CEO_ROOM: ChatRoom = { kind: 'ceo' };

/** Stable identity key for a room — query keys, queue buckets, persistence. */
export function chatRoomKey(room: ChatRoom): string {
	if (room.kind === 'ceo') return 'ceo';
	if (room.kind === 'thread') return `thread:${room.id}`;
	if (room.kind === 'group') return `group:${room.projectSlug}:${room.conversationId}`;
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
	/** Denormalized author name on group replies — the label the room saw at the time. */
	author_label?: string | null;
	/** Up to three one-tap replies the agent offered with this reply. */
	suggested_replies?: string[] | null;
}

interface ConversationData {
	conversation_id: string | null;
	messages: ChatMessage[];
	/** How many older messages have been compacted into long-term memory. */
	compacted_count: number;
	/** Group rooms only: the room's own metadata and roster. */
	title?: string | null;
	is_general?: boolean;
	participants?: GroupParticipant[];
	/** Group rooms only: replies still queued behind the latest message. */
	pending_turns?: GroupPendingTurn[];
	/**
	 * The instance has spent its monthly container-hours allowance, so a turn
	 * needing a new container is refused. Carried on the room read rather than
	 * fetched separately: the composer must be able to say so before someone
	 * types, and this is a response the surface already loads.
	 */
	hours_exhausted?: boolean;
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
 * How many CEO-room surfaces are on screen right now. The dock is only one of
 * them - the fresh-instance landing (and the chat landing preference) render
 * the same room full-pane with the dock closed - and a reply the operator is
 * watching stream in is not unread. Module-level because the badge and the
 * surfaces are separate component trees.
 */
const ceoSurfaces = { count: 0, listeners: new Set<() => void>() };

function registerCeoSurface(): () => void {
	ceoSurfaces.count += 1;
	for (const l of ceoSurfaces.listeners) l();
	return () => {
		ceoSurfaces.count -= 1;
		for (const l of ceoSurfaces.listeners) l();
	};
}

/**
 * The CEO-reply unread tally for the header monogram. Lives beside the widget
 * rather than inside `useChat` because its one consumer — the header badge —
 * renders whether or not the dock is mounted open. Joins the global HQ room
 * for its lifetime; a completed CEO reply while no CEO surface is on screen
 * bumps it, and any CEO surface appearing (the dock, the full-pane landing)
 * clears it. A visible surface also holds the conversation's own room, whose
 * duplicate Complete copy would otherwise double-count every reply.
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
		const clearWhenVisible = () => {
			if (ceoSurfaces.count > 0) {
				setUnread(0);
				writeStoredUnread(0);
			}
		};
		ceoSurfaces.listeners.add(clearWhenVisible);
		clearWhenVisible();
		return () => {
			ceoSurfaces.listeners.delete(clearWhenVisible);
		};
	}, []);
	useEffect(() => {
		const room = wsRoom.chat();
		joinRoom(room);
		return () => leaveRoom(room);
	}, [joinRoom, leaveRoom]);
	useEffect(() => {
		return subscribe(WsMessageType.ChatMessageComplete, (raw) => {
			const m = raw as WsChatMessageCompleteMessage;
			if (m.status !== ChatMessageStatus.Complete || openRef.current || ceoSurfaces.count > 0)
				return;
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
		if (
			parsed &&
			(parsed.kind === 'thread' || parsed.kind === 'agent' || parsed.kind === 'group')
		) {
			return parsed;
		}
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

/** One participant of a group room (also the author-label lookup for its bubbles). */
export interface GroupParticipant {
	member_id: string;
	slug: string;
	title: string;
	display_name: string;
}

/** One group room row in a project's room list. The built-in General room leads. */
export interface ProjectChatGroupSummary {
	id: string;
	title: string | null;
	is_general: boolean;
	last_activity_at: string | null;
	last_message_id: string | null;
	last_message_preview: string | null;
	last_message_role: string | null;
	last_message_author: string | null;
	unread: boolean;
	participants: GroupParticipant[];
}

/** A reply still queued behind a group message (the pending strip's chips). */
export type GroupPendingTurn = WsChatGroupPendingTurn;

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
	const { subscribe, joinRoom, leaveRoom } = useSocket();
	const enabled = !!projectSlug && active;
	const query = useQuery({
		queryKey: queryKeys.projectChatRooms(projectSlug ?? ''),
		queryFn: async () => {
			// The switcher and the menu cards render EVERY room, so walk the group
			// cursor to the end rather than silently stopping at page one - a page
			// the list never shows is the exact bug the paging rule names. Bounded:
			// pages are 50 rooms and the walk stops at 20 (a thousand rooms).
			const first = await api.get<{
				team_id?: string;
				conversations: ProjectChatRoomSummary[];
				groups?: ProjectChatGroupSummary[];
				groups_next_cursor?: string | null;
			}>(`/api/projects/${projectSlug}/chat/conversations`);
			let cursor = first.groups_next_cursor ?? null;
			const groups = [...(first.groups ?? [])];
			for (let pages = 0; cursor && pages < 20; pages++) {
				const next = await api.get<{
					groups?: ProjectChatGroupSummary[];
					groups_next_cursor?: string | null;
				}>(
					`/api/projects/${projectSlug}/chat/conversations?group_cursor=${encodeURIComponent(cursor)}`,
				);
				groups.push(...(next.groups ?? []));
				cursor = next.groups_next_cursor ?? null;
			}
			return { ...first, groups };
		},
		enabled,
	});
	// The team's chat signal room is where the server fans this project's
	// boundary events (start/complete) for exactly this list's benefit - the
	// per-conversation rooms carry only the one open room. Keyed by the team
	// UUID the list itself reports (rooms are UUID-keyed; URLs are slugs).
	const teamId = query.data?.team_id ?? null;
	useEffect(() => {
		if (!enabled || !teamId) return;
		const room = wsRoom.chatTeam(teamId);
		joinRoom(room);
		return () => leaveRoom(room);
	}, [enabled, teamId, joinRoom, leaveRoom]);
	// Any boundary event changes ordering, preview or unread state — refetch the
	// list. Rename/close events land as conversation-updated.
	useEffect(() => {
		if (!enabled) return;
		const invalidate = () =>
			queryClient.invalidateQueries({ queryKey: queryKeys.projectChatRooms(projectSlug ?? '') });
		const offStart = subscribe(WsMessageType.ChatMessageStart, invalidate);
		const offComplete = subscribe(WsMessageType.ChatMessageComplete, invalidate);
		const offUpdated = subscribe(WsMessageType.ChatConversationUpdated, invalidate);
		return () => {
			offStart();
			offComplete();
			offUpdated();
		};
	}, [enabled, projectSlug, subscribe, queryClient]);
	return {
		rooms: query.data?.conversations ?? [],
		groups: query.data?.groups ?? EMPTY_GROUPS,
		loaded: !query.isPending,
	};
}

/** Stable identity for "no groups" so it never re-triggers effects. */
const EMPTY_GROUPS: readonly ProjectChatGroupSummary[] = Object.freeze([]);

function conversationUrl(room: ChatRoom): string {
	if (room.kind === 'agent') {
		return `/api/projects/${encodeURIComponent(room.projectSlug)}/chat/agents/${encodeURIComponent(room.agentSlug)}/conversation`;
	}
	if (room.kind === 'group') {
		return `/api/projects/${encodeURIComponent(room.projectSlug)}/chat/groups/${encodeURIComponent(room.conversationId)}`;
	}
	if (room.kind === 'thread') {
		return `/api/chat/conversation?conversation_id=${encodeURIComponent(room.id)}`;
	}
	return '/api/chat/conversation';
}

function roomQueryKey(room: ChatRoom): readonly unknown[] {
	if (room.kind === 'agent') return queryKeys.agentChatRoom(room.projectSlug, room.agentSlug);
	if (room.kind === 'group') return queryKeys.groupChatRoom(room.projectSlug, room.conversationId);
	return queryKeys.chatConversation(room.kind === 'thread' ? room.id : undefined);
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
	const resolvedIdRef = useRef<string | null>(
		room.kind === 'thread' ? room.id : room.kind === 'group' ? room.conversationId : null,
	);
	// In-flight send: the user's messages are shown optimistically (with a pending
	// assistant placeholder) while the server warms the container, so the operator
	// gets immediate feedback instead of a blank. Cleared when the real user
	// message arrives over WS, or when the send settles (incl. failure). It's a
	// list because a flushed queue sends several messages as one turn, and it is
	// tagged with the room it was sent in so switching rooms mid-send never
	// renders (or busies) the bubble in the wrong room.
	const [pendingSend, setPendingSend] = useState<{
		roomKey: string;
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
	// Group rooms: the replies still queued behind the latest message (the
	// pending strip), fed by the server's pending-turns broadcasts.
	const [pendingTurns, setPendingTurns] = useState<GroupPendingTurn[]>([]);
	// Group rooms: the last send summoned nobody (no mention, no locus) — the
	// local nudge to tag a teammate. Never a server round trip.
	const [groupNudge, setGroupNudge] = useState(false);
	const queueKey = chatRoomKey(room);
	const queue = queues[queueKey] ?? EMPTY_QUEUE;
	const queryKey = roomQueryKey(room);

	// Room-scoped transient state: a switched-to room starts with no strip and
	// no nudge — both belong to the room they happened in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on room identity change
	useEffect(() => {
		setPendingTurns([]);
		setGroupNudge(false);
	}, [queueKey]);

	// A visible CEO room - the dock's or the full-pane landing's - suppresses
	// and clears the header monogram's unread tally: the operator is watching
	// these replies arrive.
	const isCeoSurface = active && room.kind === 'ceo';
	useEffect(() => {
		if (!isCeoSurface) return;
		return registerCeoSurface();
	}, [isCeoSurface]);

	const query = useQuery({
		queryKey,
		queryFn: () => api.get<ConversationData>(conversationUrl(room)),
		enabled: active,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	// Replay the pending strip from the read: broadcasts only reach whoever was
	// subscribed when the queue changed, so a room opened (or reloaded)
	// mid-queue would otherwise show nothing to see or cancel.
	const seededPendingTurns = query.data?.pending_turns;
	useEffect(() => {
		if (room.kind === 'group' && seededPendingTurns) setPendingTurns(seededPendingTurns);
	}, [room.kind, seededPendingTurns]);

	// Track the server-resolved conversation id so WS events can be filtered.
	resolvedIdRef.current =
		query.data?.conversation_id ??
		(room.kind === 'thread' ? room.id : room.kind === 'group' ? room.conversationId : null);

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

	// The room's own first send, still in flight: the only window in which an
	// unresolved room may accept (and anchor to) broadcast events.
	const awaitingFirstSendRef = useRef(false);

	// A cached tail stuck in a non-terminal state means the settle event landed
	// while another room was shown (events patch only the visible room, and this
	// cache never goes stale on its own). Refetch on activation so a switched-
	// back room shows the server's truth instead of eternal typing dots - and a
	// reply genuinely still streaming simply resumes from the refetched row.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run on room activation
	useEffect(() => {
		if (!active) return;
		const cached = queryClient.getQueryData<ConversationData>(queryKey);
		const tail = cached?.messages[cached.messages.length - 1];
		if (tail && tail.role === 'assistant' && tail.status === 'streaming') {
			queryClient.invalidateQueries({ queryKey });
		}
	}, [active, queueKey, queryClient]);

	// Server-side read watermark: while the room is open, the newest message is
	// what the operator has seen. Written only when the tail actually moves, and
	// never for the operator's own just-sent message (their bubble is not
	// "unread" anywhere). Fire-and-forget — a failed mark costs a stale badge,
	// but a landed one refreshes the room list so its unread dot clears now
	// rather than on the next unrelated event.
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
			.then(() => {
				if (room.kind === 'agent' || room.kind === 'group') {
					queryClient.invalidateQueries({
						queryKey: queryKeys.projectChatRooms(room.projectSlug),
					});
				}
			})
			.catch(() => undefined);
	}, [active, resolvedConversationId, serverMessagesForMark, room, queryClient]);

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
		// accepts events only while its OWN first send is in flight - that send is
		// what creates the conversation. Without the gate, any HQ event on the
		// always-joined global room (a CEO reply from another device, a task
		// breadcrumb) would render in the empty DM and anchor it to the CEO's
		// conversation for good.
		const forThisRoom = (cid?: string): boolean => {
			if (!cid) return true;
			if (resolvedIdRef.current) return cid === resolvedIdRef.current;
			return awaitingFirstSendRef.current;
		};
		const offStart = subscribe(WsMessageType.ChatMessageStart, (raw) => {
			const m = raw as WsChatMessageStartMessage;
			if (!forThisRoom(m.conversationId)) return;
			// The real user message landed — drop the optimistic placeholder so the
			// server rows (user + streaming assistant) take over without duplicating.
			if (m.role === 'user') setPendingSend((p) => (p && p.roomKey === queueKey ? null : p));
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
		// Group rooms: the server's pending-turn queue, replacing the strip whole
		// each time it changes so every open view of the room agrees.
		const offPending = subscribe(WsMessageType.ChatGroupPendingTurns, (raw) => {
			const m = raw as WsChatGroupPendingTurnsMessage;
			if (!forThisRoom(m.conversationId)) return;
			setPendingTurns(m.pending);
		});
		return () => {
			offStart();
			offDelta();
			offToolActivity();
			offComplete();
			offCompacted();
			offPending();
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
			if (room.kind === 'group') {
				return api.post<{ pending_member_ids: string[] }>(
					`/api/projects/${encodeURIComponent(room.projectSlug)}/chat/groups/${encodeURIComponent(room.conversationId)}/messages`,
					body,
				);
			}
			return api.post('/api/chat/messages', {
				...body,
				...(room.kind === 'thread' ? { conversation_id: room.id } : {}),
			});
		},
		onSuccess: (data) => {
			// A group send that summoned nobody (no mention, no locus) gets the
			// local "tag a teammate" nudge; anything else clears it.
			if (room.kind === 'group') {
				const pendingIds = (data as { pending_member_ids?: string[] })?.pending_member_ids;
				setGroupNudge(Array.isArray(pendingIds) && pendingIds.length === 0);
			}
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to send message');
		},
	});

	// Cancel one still-queued group reply (a chip on the pending strip). The
	// server broadcasts the updated queue, which is what removes the chip - a
	// security-irrelevant but server-owned state, so no optimistic removal.
	const cancelTurnMutation = useMutation({
		mutationFn: (memberId: string) => {
			if (room.kind !== 'group') return Promise.resolve({});
			return api.post(
				`/api/projects/${encodeURIComponent(room.projectSlug)}/chat/groups/${encodeURIComponent(room.conversationId)}/cancel-turn`,
				{ member_id: memberId },
			);
		},
		// A failed or raced cancel must not die silently while the chip stays lit.
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to cancel the reply');
		},
	});

	const serverMessages = query.data?.messages ?? [];
	// Append the optimistic user bubbles + a pending assistant "thinking"
	// placeholder while a send is in flight - only in the room the send belongs
	// to, so flipping rooms mid-send never shows (or busies) the wrong room. A
	// group room skips the assistant placeholder: who replies (or that nobody
	// does) is the server's call, and the pending strip is that answer.
	const pending = pendingSend && pendingSend.roomKey === queueKey ? pendingSend : null;
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
					...(room.kind === 'group'
						? []
						: [
								{
									id: 'optimistic-assistant',
									role: 'assistant' as ChatMessageRole,
									channel: 'web' as ChatChannel,
									status: 'streaming' as ChatMessageStatus,
									content: '',
									created_at: pending.at,
								},
							]),
				]
			: serverMessages;
	const streaming = messages.some((m) => m.role === 'assistant' && m.status === 'streaming');
	const sending = pending !== null;

	const { mutateAsync } = sendMutation;
	const sendBatch = useCallback(
		(batch: OutboundChatMessage[]) => {
			if (batch.length === 0) return Promise.resolve();
			setGroupNudge(false);
			const sentKey = queueKey;
			if (!resolvedIdRef.current) awaitingFirstSendRef.current = true;
			setPendingSend({ roomKey: sentKey, at: new Date().toISOString(), messages: batch });
			return mutateAsync(batch, {
				// Clear the optimistic placeholder once the request settles — on
				// success the WS user-message event has already cleared it; on failure
				// this drops the unsent bubble. Keyed to the SENDING room, whatever
				// room is shown by then.
				onSettled: () => {
					awaitingFirstSendRef.current = false;
					setPendingSend((p) => (p && p.roomKey === sentKey ? null : p));
				},
			});
		},
		[mutateAsync, queueKey],
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
		// The allowance is spent: a reply needing a new container will not start.
		// Warm reuse still serves, so this warns rather than locking the composer.
		hoursExhausted: query.data?.hours_exhausted === true,
		// Group rooms: the roster (author-label lookup), the pending strip, its
		// cancel, and the local "tag a teammate" nudge. Inert everywhere else.
		participants: query.data?.participants ?? EMPTY_PARTICIPANTS,
		pendingTurns,
		cancelPendingTurn: (memberId: string) => {
			cancelTurnMutation.mutate(memberId);
		},
		groupNudge,
	};
}

/** Stable identity for "no participants" so it never re-triggers effects. */
const EMPTY_PARTICIPANTS: readonly GroupParticipant[] = Object.freeze([]);
