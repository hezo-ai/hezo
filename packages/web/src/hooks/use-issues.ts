import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Issue {
	id: string;
	company_id: string;
	project_id: string | null;
	identifier: string;
	number: number;
	title: string;
	description: string | null;
	status: string;
	priority: string;
	assignee_id: string | null;
	assignee_name: string | null;
	assignee_type: 'agent' | 'user' | null;
	has_active_run: boolean;
	parent_issue_id: string | null;
	labels: string[];
	progress_summary: string | null;
	rules: string | null;
	project_name: string | null;
	comment_count: number;
	cost_cents: number;
	created_at: string;
	updated_at: string;
}

export interface IssueFilters {
	status?: string;
	priority?: string;
	project_id?: string;
	assignee_id?: string;
	search?: string;
	sort?: string;
	page?: string;
	per_page?: string;
}

interface IssueListResponse {
	data: Issue[];
	meta: { page: number; per_page: number; total: number };
}

export function useIssues(companyId: string, filters?: IssueFilters) {
	return useQuery({
		queryKey: ['companies', companyId, 'issues', filters],
		queryFn: async () => {
			const params: Record<string, string | undefined> = { ...filters };
			const res = await api.get<IssueListResponse | Issue[]>(
				`/api/companies/${companyId}/issues`,
				params,
			);
			if (Array.isArray(res))
				return { data: res, meta: { page: 1, per_page: 50, total: res.length } };
			return res;
		},
	});
}

export function useIssue(companyId: string, issueId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'issues', issueId],
		queryFn: () => api.get<Issue>(`/api/companies/${companyId}/issues/${issueId}`),
	});
}

export function useCreateIssue(companyId: string) {
	return useMutation({
		mutationFn: (data: {
			project_id: string;
			title: string;
			description?: string;
			assignee_id?: string;
			priority?: string;
			labels?: string[];
		}) => api.post<Issue>(`/api/companies/${companyId}/issues`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'issues'] }),
	});
}

export function useUpdateIssue(companyId: string, issueId: string) {
	return useMutation({
		mutationFn: (data: {
			title?: string;
			description?: string;
			status?: string;
			priority?: string;
			assignee_id?: string | null;
			labels?: string[];
			progress_summary?: string | null;
			rules?: string | null;
		}) => api.patch<Issue>(`/api/companies/${companyId}/issues/${issueId}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'issues'] });
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'issues', issueId] });
		},
	});
}

export function useDeleteIssue(companyId: string) {
	return useMutation({
		mutationFn: (issueId: string) => api.delete(`/api/companies/${companyId}/issues/${issueId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'issues'] }),
	});
}

export function useCreateSubIssue(companyId: string, parentIssueId: string) {
	return useMutation({
		mutationFn: (data: {
			title: string;
			description?: string;
			assignee_id?: string;
			priority?: string;
		}) => api.post<Issue>(`/api/companies/${companyId}/issues/${parentIssueId}/sub-issues`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'issues'] }),
	});
}

export interface IssueDependency {
	id: string;
	issue_id: string;
	blocked_by_issue_id: string;
	blocked_by_identifier: string;
	blocked_by_title: string;
	blocked_by_status: string;
}

export function useIssueDependencies(companyId: string, issueId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'issues', issueId, 'dependencies'],
		queryFn: () =>
			api.get<IssueDependency[]>(`/api/companies/${companyId}/issues/${issueId}/dependencies`),
	});
}

export function useAddDependency(companyId: string, issueId: string) {
	return useMutation({
		mutationFn: (blockedByIssueId: string) =>
			api.post(`/api/companies/${companyId}/issues/${issueId}/dependencies`, {
				blocked_by_issue_id: blockedByIssueId,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'dependencies'],
			}),
	});
}

export function useRemoveDependency(companyId: string, issueId: string) {
	return useMutation({
		mutationFn: (depId: string) =>
			api.delete(`/api/companies/${companyId}/issues/${issueId}/dependencies/${depId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'issues', issueId, 'dependencies'],
			}),
	});
}
