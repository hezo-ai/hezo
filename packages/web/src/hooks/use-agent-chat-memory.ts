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
			// A content change snapshots what it replaced, so the history is stale too.
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.agentChatMemoryRevisions(projectId, agentId),
			});
		},
	});
}

export interface ChatMemoryRevision {
	id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	/** Display name of the operator who wrote it; null for automatic compaction. */
	author_name: string | null;
	/** 'admin' when a person wrote it; 'agent' for the agent's own compaction. */
	author_type: string;
	created_at: string;
}

/** Revision history for the agent's long-term memory, newest first. */
export function useAgentChatMemoryRevisions(projectId: string, agentId: string) {
	return useQuery({
		queryKey: queryKeys.projects.agentChatMemoryRevisions(projectId, agentId),
		queryFn: () =>
			api.get<ChatMemoryRevision[]>(
				`/api/projects/${projectId}/agents/${agentId}/chat-memory/revisions`,
			),
		enabled: !!projectId && !!agentId,
	});
}

/**
 * Restore a past long-term memory version. Invalidate-and-refetch rather than
 * optimistic: a restore appends a new revision, so both the memory and its history
 * are stale afterwards.
 */
export function useRestoreAgentChatMemory(projectId: string, agentId: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post(`/api/projects/${projectId}/agents/${agentId}/chat-memory/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.agentChatMemory(projectId, agentId),
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.agentChatMemoryRevisions(projectId, agentId),
			});
		},
	});
}
