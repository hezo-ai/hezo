import {
	type ChatChannel,
	type ChatMessageRole,
	ChatMessageStatus,
	type WsChatMessageCompleteMessage,
	type WsChatMessageDeltaMessage,
	type WsChatMessageStartMessage,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
}

interface ConversationData {
	conversation_id: string;
	messages: ChatMessage[];
	/** How many older messages have been compacted into long-term memory. */
	compacted_count: number;
}

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
 * Drives the single global CEO chat. The TanStack Query cache is the source of
 * truth for messages (keyed by {@link queryKeys.chatConversation}); the initial
 * history loads via `useQuery` and streamed start/delta/complete events from the
 * `chat:global` room are folded into the same cache entry via `setQueryData`.
 * Because every surface mirrors the one conversation, the user's own messages
 * (echoed back over the socket) arrive the same way. The query never refetches
 * on its own (`staleTime: Infinity`) so an in-flight reply's accumulated deltas
 * aren't clobbered by a server snapshot that only persists on completion.
 */
export function useChat(active: boolean) {
	const { subscribe, joinRoom, leaveRoom } = useSocket();
	const queryClient = useQueryClient();
	const [unread, setUnread] = useState<number>(readStoredUnread);
	// In-flight send: the user's text is shown optimistically (with a pending
	// assistant placeholder) while the server warms the session / egress check, so
	// the operator gets immediate feedback instead of a ~10s blank. Cleared when the
	// real user message arrives over WS, or when the send settles (incl. failure).
	const [pending, setPending] = useState<{
		text: string;
		at: string;
		attachments: CommentAttachment[];
	} | null>(null);
	// The socket handler is wired once; this ref lets it read the live open state
	// (whether the chat is currently visible) without re-subscribing every toggle.
	const activeRef = useRef(active);
	useEffect(() => {
		activeRef.current = active;
	}, [active]);

	const query = useQuery({
		queryKey: queryKeys.chatConversation(),
		queryFn: () => api.get<ConversationData>('/api/chat/conversation'),
		enabled: active,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});

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
			queryClient.setQueryData<ConversationData>(queryKeys.chatConversation(), (prev) =>
				prev ? { ...prev, messages: fn(prev.messages) } : prev,
			);
		};
		const offStart = subscribe(WsMessageType.ChatMessageStart, (raw) => {
			const m = raw as WsChatMessageStartMessage;
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
							},
						],
			);
		});
		const offDelta = subscribe(WsMessageType.ChatMessageDelta, (raw) => {
			const m = raw as WsChatMessageDeltaMessage;
			patch((messages) =>
				messages.map((x) => (x.id === m.messageId ? { ...x, content: x.content + m.text } : x)),
			);
		});
		const offComplete = subscribe(WsMessageType.ChatMessageComplete, (raw) => {
			const m = raw as WsChatMessageCompleteMessage;
			patch((messages) =>
				messages.map((x) =>
					x.id === m.messageId ? { ...x, content: m.content, status: m.status } : x,
				),
			);
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
		const offCompacted = subscribe(WsMessageType.ChatCompacted, () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.chatConversation() });
		});
		return () => {
			offStart();
			offDelta();
			offComplete();
			offCompacted();
		};
	}, [subscribe, queryClient]);

	const sendMutation = useMutation({
		mutationFn: ({ text, attachmentIds }: { text: string; attachmentIds: string[] }) =>
			api.post('/api/chat/messages', { text, attachment_ids: attachmentIds }),
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to send message to the CEO');
		},
		// Clear the optimistic placeholder once the request settles — on success the
		// WS user-message event has already cleared it; on failure (e.g. egress gate
		// reject, toasted above) this drops the unsent bubble.
		onSettled: () => setPending(null),
	});

	const serverMessages = query.data?.messages ?? [];
	// Append the optimistic user bubble + a pending assistant "thinking" placeholder
	// while a send is in flight (an assistant row with empty streaming content renders
	// the existing typing indicator). They're dropped the moment the real rows arrive.
	const messages: ChatMessage[] =
		pending !== null
			? [
					...serverMessages,
					{
						id: 'optimistic-user',
						role: 'user' as ChatMessageRole,
						channel: 'web' as ChatChannel,
						status: 'complete' as ChatMessageStatus,
						content: pending.text,
						created_at: pending.at,
						attachments: pending.attachments,
					},
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

	const send = (text: string, attachments: CommentAttachment[] = []) => {
		const trimmed = text.trim();
		if (!trimmed && attachments.length === 0) return Promise.resolve();
		setPending({ text: trimmed, at: new Date().toISOString(), attachments });
		return sendMutation.mutateAsync({ text: trimmed, attachmentIds: attachments.map((a) => a.id) });
	};

	return {
		messages,
		send,
		streaming,
		sending: pending !== null,
		loaded: !query.isPending,
		unread,
		// >0 once older messages have been compacted into long-term memory; drives
		// the "chat compacted" marker at the top of the window.
		compactedCount: query.data?.compacted_count ?? 0,
	};
}
