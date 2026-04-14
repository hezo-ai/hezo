import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

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
	tool_calls?: unknown[];
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
		mutationFn: (data: { content: string; content_type?: string; effort?: string }) =>
			api.post<Comment>(`/api/companies/${companyId}/issues/${issueId}/comments`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'comments'],
			}),
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
