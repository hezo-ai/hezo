import { type WsChatMessage, WsMessageType } from '@hezo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';

export interface ChatMessage {
	id: string;
	chat_id: string;
	author_member_id: string | null;
	author_type: string;
	author_name?: string;
	content: string;
	metadata: Record<string, unknown>;
	created_at: string;
}

export function useChatMessages(companyId: string, issueId: string) {
	const queryClient = useQueryClient();

	useEffect(() => {
		const unsubscribe = wsClient.on(WsMessageType.ChatMessage, (msg) => {
			const chatMsg = msg as WsChatMessage;
			if (chatMsg.issueId === issueId) {
				queryClient.invalidateQueries({
					queryKey: ['companies', companyId, 'issues', issueId, 'chat'],
				});
			}
		});
		return unsubscribe;
	}, [companyId, issueId, queryClient]);

	return useQuery({
		queryKey: ['companies', companyId, 'issues', issueId, 'chat'],
		queryFn: () =>
			api.get<ChatMessage[]>(`/api/companies/${companyId}/issues/${issueId}/chat/messages`),
	});
}

export function useSendChatMessage(companyId: string, issueId: string) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (content: string) =>
			api.post<ChatMessage>(`/api/companies/${companyId}/issues/${issueId}/chat/messages`, {
				content,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'chat'],
			});
		},
	});
}
