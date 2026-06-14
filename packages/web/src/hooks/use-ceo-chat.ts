import {
	type CeoChannel,
	type CeoMessageRole,
	type CeoMessageStatus,
	type WsCeoMessageCompleteMessage,
	type WsCeoMessageDeltaMessage,
	type WsCeoMessageStartMessage,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSocket } from '../contexts/socket-context';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface CeoMessage {
	id: string;
	role: CeoMessageRole;
	channel: CeoChannel;
	status: CeoMessageStatus;
	content: string;
	created_at: string;
}

interface ConversationData {
	conversation_id: string;
	messages: CeoMessage[];
}

/**
 * Drives the single global CEO chat. The TanStack Query cache is the source of
 * truth for messages (keyed by {@link queryKeys.ceoConversation}); the initial
 * history loads via `useQuery` and streamed start/delta/complete events from the
 * `ceo:global` room are folded into the same cache entry via `setQueryData`.
 * Because every surface mirrors the one conversation, the user's own messages
 * (echoed back over the socket) arrive the same way. The query never refetches
 * on its own (`staleTime: Infinity`) so an in-flight reply's accumulated deltas
 * aren't clobbered by a server snapshot that only persists on completion.
 */
export function useCeoChat(active: boolean) {
	const { subscribe, joinRoom, leaveRoom } = useSocket();
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: queryKeys.ceoConversation(),
		queryFn: () => api.get<ConversationData>('/api/ceo/conversation'),
		enabled: active,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});

	useEffect(() => {
		if (!active) return;
		const room = wsRoom.ceo();
		joinRoom(room);
		return () => leaveRoom(room);
	}, [active, joinRoom, leaveRoom]);

	useEffect(() => {
		const patch = (fn: (messages: CeoMessage[]) => CeoMessage[]) => {
			queryClient.setQueryData<ConversationData>(queryKeys.ceoConversation(), (prev) =>
				prev ? { ...prev, messages: fn(prev.messages) } : prev,
			);
		};
		const offStart = subscribe(WsMessageType.CeoMessageStart, (raw) => {
			const m = raw as WsCeoMessageStartMessage;
			patch((messages) =>
				messages.some((x) => x.id === m.messageId)
					? messages
					: [
							...messages,
							{
								id: m.messageId,
								role: m.role,
								channel: m.channel,
								status: (m.role === 'assistant' ? 'streaming' : 'complete') as CeoMessageStatus,
								content: m.content,
								created_at: m.createdAt,
							},
						],
			);
		});
		const offDelta = subscribe(WsMessageType.CeoMessageDelta, (raw) => {
			const m = raw as WsCeoMessageDeltaMessage;
			patch((messages) =>
				messages.map((x) => (x.id === m.messageId ? { ...x, content: x.content + m.text } : x)),
			);
		});
		const offComplete = subscribe(WsMessageType.CeoMessageComplete, (raw) => {
			const m = raw as WsCeoMessageCompleteMessage;
			patch((messages) =>
				messages.map((x) =>
					x.id === m.messageId ? { ...x, content: m.content, status: m.status } : x,
				),
			);
		});
		return () => {
			offStart();
			offDelta();
			offComplete();
		};
	}, [subscribe, queryClient]);

	const sendMutation = useMutation({
		mutationFn: (text: string) => api.post('/api/ceo/messages', { text }),
	});

	const messages = query.data?.messages ?? [];
	const streaming = messages.some((m) => m.role === 'assistant' && m.status === 'streaming');

	return {
		messages,
		send: (text: string) => sendMutation.mutateAsync(text.trim()),
		streaming,
		loaded: !query.isPending,
	};
}
