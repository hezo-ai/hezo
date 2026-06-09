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
import { useCallback, useEffect, useState } from 'react';
import { useSocket } from '../contexts/socket-context';
import { api } from '../lib/api';

export interface CeoMessage {
	id: string;
	role: CeoMessageRole;
	channel: CeoChannel;
	status: CeoMessageStatus;
	content: string;
	created_at: string;
}

interface ConversationResponse {
	conversation_id: string;
	messages: CeoMessage[];
}

/**
 * Drives the single global CEO chat: loads history, subscribes to the
 * `ceo:global` room, and folds streamed start/delta/complete events into local
 * message state. Because every surface mirrors the same conversation, messages
 * (including the user's own, echoed back over the socket) all arrive via WS.
 */
export function useCeoChat(active: boolean) {
	const { subscribe, joinRoom, leaveRoom } = useSocket();
	const [messages, setMessages] = useState<CeoMessage[]>([]);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		if (!active || loaded) return;
		let cancelled = false;
		api
			.get<ConversationResponse>('/api/ceo/conversation')
			.then((res) => {
				if (!cancelled) {
					setMessages(res.messages);
					setLoaded(true);
				}
			})
			.catch(() => {
				if (!cancelled) setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [active, loaded]);

	useEffect(() => {
		if (!active) return;
		const room = wsRoom.ceo();
		joinRoom(room);
		return () => leaveRoom(room);
	}, [active, joinRoom, leaveRoom]);

	useEffect(() => {
		const offStart = subscribe(WsMessageType.CeoMessageStart, (raw) => {
			const m = raw as WsCeoMessageStartMessage;
			setMessages((prev) =>
				prev.some((x) => x.id === m.messageId)
					? prev
					: [
							...prev,
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
			setMessages((prev) =>
				prev.map((x) => (x.id === m.messageId ? { ...x, content: x.content + m.text } : x)),
			);
		});
		const offComplete = subscribe(WsMessageType.CeoMessageComplete, (raw) => {
			const m = raw as WsCeoMessageCompleteMessage;
			setMessages((prev) =>
				prev.map((x) =>
					x.id === m.messageId ? { ...x, content: m.content, status: m.status } : x,
				),
			);
		});
		return () => {
			offStart();
			offDelta();
			offComplete();
		};
	}, [subscribe]);

	const send = useCallback(async (text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		await api.post('/api/ceo/messages', { text: trimmed });
	}, []);

	const streaming = messages.some((m) => m.role === 'assistant' && m.status === 'streaming');

	return { messages, send, streaming, loaded };
}
