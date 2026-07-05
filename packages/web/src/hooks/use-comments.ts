import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
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
	/**
	 * Human-friendly per-task slug (creation timestamp, e.g. `20261009112345`)
	 * used for deep-link anchors and `<TASK-ID>#comment-<public_id>` mention
	 * links. `id` (the UUID) stays the key for API calls and parent references.
	 */
	public_id: string;
	task_id: string;
	content_type: string;
	content: string;
	chosen_option: string | null;
	created_at: string;
	author_type: string;
	author_name: string;
	author_member_id: string | null;
	author_api_key_id: string | null;
	parent_comment_id: string | null;
	reactions?: ReactionGroup[];
	attachments?: CommentAttachment[];
}

export function useComments(projectId: string, taskId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.projects.taskComments(projectId, taskId),
		queryFn: () => api.get<Comment[]>(`/api/projects/${projectId}/tasks/${taskId}/comments`),
		enabled: options?.enabled ?? true,
		staleTime: 0,
	});
}

export function useCreateComment(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: (data: {
			content: string;
			content_type?: string;
			effort?: string;
			wake_assignee?: boolean;
			parent_comment_id?: string;
			attachment_ids?: string[];
		}) => api.post<Comment>(`/api/projects/${projectId}/tasks/${taskId}/comments`, data),
		onSuccess: (created) => {
			queryClient.setQueryData<Comment[]>(
				queryKeys.projects.taskComments(projectId, taskId),
				(old) => {
					if (!old) return [created];
					if (old.some((c) => c.id === created.id)) return old;
					return [...old, created];
				},
			);
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			});
		},
	});
}

/**
 * Create a comment on a task chosen at call time (e.g. the action-review
 * "Add to task" picker). Same cache handling as `useCreateComment`, but the
 * target task travels in the mutation variables instead of the hook args.
 */
export function useCreateCommentOnTask(projectId: string) {
	return useMutation({
		mutationFn: ({ taskId, content }: { taskId: string; content: string }) =>
			api.post<Comment>(`/api/projects/${projectId}/tasks/${taskId}/comments`, { content }),
		onSuccess: (created, { taskId }) => {
			queryClient.setQueryData<Comment[]>(
				queryKeys.projects.taskComments(projectId, taskId),
				(old) => {
					if (!old) return [created];
					if (old.some((c) => c.id === created.id)) return old;
					return [...old, created];
				},
			);
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			});
		},
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

export function useAddReaction(projectId: string, taskId: string) {
	return useOptimisticMutation<
		{ commentId: string; kind: string },
		ReactionMutationResponse,
		Comment[]
	>({
		mutationFn: ({ commentId, kind }) =>
			api.put<ReactionMutationResponse>(
				`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/reactions/${kind}`,
				{},
			),
		queryKey: queryKeys.projects.taskComments(projectId, taskId),
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

export function useRemoveReaction(projectId: string, taskId: string) {
	return useOptimisticMutation<
		{ commentId: string; kind: string },
		ReactionMutationResponse,
		Comment[]
	>({
		mutationFn: ({ commentId, kind }) =>
			api.delete<ReactionMutationResponse>(
				`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/reactions/${kind}`,
			),
		queryKey: queryKeys.projects.taskComments(projectId, taskId),
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

/**
 * Approve or deny an agent-filed asset deletion request. Response-driven —
 * never optimistic: approval permanently deletes assets server-side, so the
 * card must only flip once the server confirms. Refreshes the thread, the
 * assets library, and the inbox badge (the request's mentions are marked read).
 */
export function useResolveAssetDeletion(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: ({ commentId, approve }: { commentId: string; approve: boolean }) =>
			api.post(
				`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/resolve-asset-deletion`,
				{ approve },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.assets(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxCount(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxMentions(projectId) });
		},
	});
}

export function useFulfillCredential(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: ({
			commentId,
			value,
			confirmed,
			allowedHosts,
			allowBodySubstitution,
		}: {
			commentId: string;
			value?: string;
			confirmed?: boolean;
			allowedHosts?: string[];
			allowBodySubstitution?: boolean;
		}) =>
			api.post(
				`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
				{
					value,
					confirmed,
					allowed_hosts: allowedHosts,
					allow_body_substitution: allowBodySubstitution,
				},
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			}),
	});
}
