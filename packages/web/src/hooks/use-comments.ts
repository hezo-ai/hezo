import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface ReactionMember {
	id: string;
	slug: string | null;
	display_name: string | null;
}

export interface ReactionGroup {
	kind: string;
	members: ReactionMember[];
	you_reacted: boolean;
}

export interface CommentAttachment {
	id: string;
	content_type: string;
	byte_size: number;
	original_filename: string;
	url: string;
}

export interface Comment {
	id: string;
	task_id: string;
	content_type: string;
	content: string;
	chosen_option: string | null;
	created_at: string;
	author_type: string;
	author_name: string;
	author_member_id: string | null;
	parent_comment_id: string | null;
	tool_calls?: unknown[];
	reactions?: ReactionGroup[];
	attachments?: CommentAttachment[];
}

export function useComments(teamId: string, taskId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
		queryFn: () =>
			api.get<Comment[]>(`/api/teams/${teamId}/tasks/${taskId}/comments`, {
				include_tool_calls: 'true',
			}),
		enabled: options?.enabled ?? true,
		staleTime: 0,
	});
}

export function useCreateComment(teamId: string, taskId: string) {
	return useMutation({
		mutationFn: (data: {
			content: string;
			content_type?: string;
			effort?: string;
			wake_assignee?: boolean;
			parent_comment_id?: string;
			attachment_ids?: string[];
		}) => api.post<Comment>(`/api/teams/${teamId}/tasks/${taskId}/comments`, data),
		onSuccess: (created) => {
			queryClient.setQueryData<Comment[]>(['teams', teamId, 'tasks', taskId, 'comments'], (old) => {
				if (!old) return [created];
				if (old.some((c) => c.id === created.id)) return old;
				return [...old, created];
			});
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
			});
		},
	});
}

export function useChooseOption(teamId: string, taskId: string) {
	return useMutation({
		mutationFn: ({ commentId, chosen_id }: { commentId: string; chosen_id: string }) =>
			api.post(`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/choose`, {
				chosen_id,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
			}),
	});
}

export interface ReactionMutationResponse {
	comment_id: string;
	kind: string;
	reactions: ReactionGroup[];
}

function applyReactionResponse(teamId: string, taskId: string, updated: ReactionMutationResponse) {
	const key = ['teams', teamId, 'tasks', taskId, 'comments'];
	queryClient.setQueryData<Comment[] | undefined>(key, (current) => {
		if (!current) return current;
		let changed = false;
		const next = current.map((c) => {
			if (c.id !== updated.comment_id) return c;
			changed = true;
			return { ...c, reactions: updated.reactions };
		});
		return changed ? next : current;
	});
}

export function useAddReaction(teamId: string, taskId: string) {
	return useMutation({
		mutationFn: ({ commentId, kind }: { commentId: string; kind: string }) =>
			api.put<ReactionMutationResponse>(
				`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${kind}`,
				{},
			),
		onSuccess: (updated) => applyReactionResponse(teamId, taskId, updated),
	});
}

export function useRemoveReaction(teamId: string, taskId: string) {
	return useMutation({
		mutationFn: ({ commentId, kind }: { commentId: string; kind: string }) =>
			api.delete<ReactionMutationResponse>(
				`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${kind}`,
			),
		onSuccess: (updated) => applyReactionResponse(teamId, taskId, updated),
	});
}

export function useFulfillCredential(teamId: string, taskId: string) {
	return useMutation({
		mutationFn: ({
			commentId,
			value,
			confirmed,
		}: {
			commentId: string;
			value?: string;
			confirmed?: boolean;
		}) =>
			api.post(`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/fulfill-credential`, {
				value,
				confirmed,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
			}),
	});
}
