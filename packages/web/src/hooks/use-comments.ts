import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useOptimisticMutation } from './use-optimistic-mutation';

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
	return useOptimisticMutation<{ commentId: string; chosen_id: string }, unknown, Comment[]>({
		mutationFn: ({ commentId, chosen_id }) =>
			api.post(`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/choose`, {
				chosen_id,
			}),
		queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
		applyOptimistic: (current, { commentId, chosen_id }) => {
			if (!current) return current;
			return current.map((c) => (c.id === commentId ? { ...c, chosen_option: chosen_id } : c));
		},
		errorMessage: 'Failed to choose option',
	});
}

export interface ReactionMutationResponse {
	comment_id: string;
	kind: string;
	reactions: ReactionGroup[];
}

const OPTIMISTIC_MEMBER: ReactionMember = {
	id: '__optimistic__',
	slug: null,
	display_name: 'You',
};

function predictAddReaction(reactions: ReactionGroup[] | undefined, kind: string): ReactionGroup[] {
	const groups = reactions ?? [];
	const existing = groups.find((g) => g.kind === kind);
	if (existing?.you_reacted) return groups;
	if (existing) {
		return groups.map((g) =>
			g.kind === kind ? { ...g, you_reacted: true, members: [...g.members, OPTIMISTIC_MEMBER] } : g,
		);
	}
	return [...groups, { kind, members: [OPTIMISTIC_MEMBER], you_reacted: true }];
}

function predictRemoveReaction(
	reactions: ReactionGroup[] | undefined,
	kind: string,
): ReactionGroup[] {
	const groups = reactions ?? [];
	const existing = groups.find((g) => g.kind === kind);
	if (!existing?.you_reacted) return groups;
	return groups
		.map((g) => {
			if (g.kind !== kind) return g;
			const removedIdx = g.members.findIndex((m) => m.id === OPTIMISTIC_MEMBER.id);
			const members =
				removedIdx >= 0
					? [...g.members.slice(0, removedIdx), ...g.members.slice(removedIdx + 1)]
					: g.members.slice(0, -1);
			return { ...g, you_reacted: false, members };
		})
		.filter((g) => g.members.length > 0);
}

function applyToComment(
	current: Comment[] | undefined,
	commentId: string,
	update: (c: Comment) => Comment,
): Comment[] | undefined {
	if (!current) return current;
	return current.map((c) => (c.id === commentId ? update(c) : c));
}

export function useAddReaction(teamId: string, taskId: string) {
	return useOptimisticMutation<
		{ commentId: string; kind: string },
		ReactionMutationResponse,
		Comment[]
	>({
		mutationFn: ({ commentId, kind }) =>
			api.put<ReactionMutationResponse>(
				`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${kind}`,
				{},
			),
		queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
		applyOptimistic: (current, { commentId, kind }) =>
			applyToComment(current, commentId, (c) => ({
				...c,
				reactions: predictAddReaction(c.reactions, kind),
			})),
		mergeResponse: (current, updated) =>
			applyToComment(current, updated.comment_id, (c) => ({ ...c, reactions: updated.reactions })),
		errorMessage: 'Failed to add reaction',
	});
}

export function useRemoveReaction(teamId: string, taskId: string) {
	return useOptimisticMutation<
		{ commentId: string; kind: string },
		ReactionMutationResponse,
		Comment[]
	>({
		mutationFn: ({ commentId, kind }) =>
			api.delete<ReactionMutationResponse>(
				`/api/teams/${teamId}/tasks/${taskId}/comments/${commentId}/reactions/${kind}`,
			),
		queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
		applyOptimistic: (current, { commentId, kind }) =>
			applyToComment(current, commentId, (c) => ({
				...c,
				reactions: predictRemoveReaction(c.reactions, kind),
			})),
		mergeResponse: (current, updated) =>
			applyToComment(current, updated.comment_id, (c) => ({ ...c, reactions: updated.reactions })),
		errorMessage: 'Failed to remove reaction',
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
