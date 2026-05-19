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

export interface Comment {
	id: string;
	issue_id: string;
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
}

export function useComments(companyId: string, issueId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'issues', issueId, 'comments'],
		queryFn: () =>
			api.get<Comment[]>(`/api/companies/${companyId}/issues/${issueId}/comments`, {
				include_tool_calls: 'true',
			}),
	});
}

export function useCreateComment(companyId: string, issueId: string) {
	return useMutation({
		mutationFn: (data: {
			content: string;
			content_type?: string;
			effort?: string;
			wake_assignee?: boolean;
			parent_comment_id?: string;
		}) => api.post<Comment>(`/api/companies/${companyId}/issues/${issueId}/comments`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'comments'],
			});
		},
	});
}

export function useChooseOption(companyId: string, issueId: string) {
	return useMutation({
		mutationFn: ({ commentId, chosen_id }: { commentId: string; chosen_id: string }) =>
			api.post(`/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/choose`, {
				chosen_id,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'comments'],
			}),
	});
}

export interface ReactionMutationResponse {
	comment_id: string;
	kind: string;
	reactions: ReactionGroup[];
}

export function useAddReaction(companyId: string, issueId: string) {
	return useMutation({
		mutationFn: ({ commentId, kind }: { commentId: string; kind: string }) =>
			api.put<ReactionMutationResponse>(
				`/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/reactions/${kind}`,
				{},
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'comments'],
			}),
	});
}

export function useRemoveReaction(companyId: string, issueId: string) {
	return useMutation({
		mutationFn: ({ commentId, kind }: { commentId: string; kind: string }) =>
			api.delete<ReactionMutationResponse>(
				`/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/reactions/${kind}`,
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'comments'],
			}),
	});
}

export function useFulfillCredential(companyId: string, issueId: string) {
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
			api.post(
				`/api/companies/${companyId}/issues/${issueId}/comments/${commentId}/fulfill-credential`,
				{ value, confirmed },
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'comments'],
			}),
	});
}
