import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface AgentChatMemory {
	content: string;
	updated_at: string | null;
}

/** The agent's long-term compacted chat memory (the Chat history tab). */
export function useAgentChatMemory(projectId: string, agentId: string) {
	return useQuery({
		queryKey: queryKeys.projects.agentChatMemory(projectId, agentId),
		queryFn: () =>
			api.get<AgentChatMemory>(`/api/projects/${projectId}/agents/${agentId}/chat-memory`),
	});
}

/**
 * Operator edit of the long-term memory. Response-driven: the server echoes the
 * stored value (with a fresh `updated_at`), which seeds the cache.
 */
export function useUpdateAgentChatMemory(projectId: string, agentId: string) {
	return useMutation({
		mutationFn: (content: string) =>
			api.put<AgentChatMemory>(`/api/projects/${projectId}/agents/${agentId}/chat-memory`, {
				content,
			}),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.projects.agentChatMemory(projectId, agentId), data);
		},
	});
}
