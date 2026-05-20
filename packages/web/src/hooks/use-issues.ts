import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Issue {
	id: string;
	team_id: string;
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
	project_slug: string | null;
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
	parent_issue_id?: string;
	search?: string;
	sort?: string;
	page?: string;
	per_page?: string;
}

interface IssueListResponse {
	data: Issue[];
	meta: { page: number; per_page: number; total: number };
}

export function useIssues(teamId: string, filters?: IssueFilters, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: ['teams', teamId, 'issues', filters],
		queryFn: async () => {
			const params: Record<string, string | undefined> = { ...filters };
			const res = await api.get<IssueListResponse | Issue[]>(`/api/teams/${teamId}/issues`, params);
			if (Array.isArray(res))
				return { data: res, meta: { page: 1, per_page: 50, total: res.length } };
			return res;
		},
		enabled: options?.enabled ?? true,
	});
}

export function useIssue(teamId: string, issueId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'issues', issueId],
		queryFn: () => api.get<Issue>(`/api/teams/${teamId}/issues/${issueId}`),
	});
}

export interface IssueMentionData {
	identifier: string;
	title: string;
	project_slug: string;
	status: string;
}

export function useIssueMentions(teamId: string, candidates: string[]) {
	const key = useMemo(
		() => [...new Set(candidates.map((s) => s.toLowerCase()))].sort(),
		[candidates],
	);
	return useQuery({
		queryKey: ['teams', teamId, 'issues', 'resolve', key],
		queryFn: () =>
			api.post<IssueMentionData[]>(`/api/teams/${teamId}/issues/resolve`, {
				identifiers: key,
			}),
		enabled: !!teamId && key.length > 0,
		staleTime: 60_000,
	});
}

export function useCreateIssue(teamId: string) {
	return useMutation({
		mutationFn: (data: {
			project_id: string;
			title: string;
			description?: string;
			assignee_id?: string;
			priority?: string;
			labels?: string[];
		}) => api.post<Issue>(`/api/teams/${teamId}/issues`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'issues'] }),
	});
}

export function useUpdateIssue(teamId: string, issueId: string) {
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
		}) => api.patch<Issue>(`/api/teams/${teamId}/issues/${issueId}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'issues'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'issues', issueId] });
		},
	});
}

export interface IssueAncestor {
	id: string;
	identifier: string;
	title: string;
}

export function useIssueAncestors(teamId: string, issueId: string | undefined) {
	return useQuery({
		queryKey: ['teams', teamId, 'issues', issueId, 'ancestors'],
		queryFn: () => api.get<IssueAncestor[]>(`/api/teams/${teamId}/issues/${issueId}/ancestors`),
		enabled: !!teamId && !!issueId,
	});
}

export function useCreateSubIssue(teamId: string, parentIssueId: string) {
	return useMutation({
		mutationFn: (data: {
			title: string;
			description?: string;
			assignee_id?: string;
			priority?: string;
		}) => api.post<Issue>(`/api/teams/${teamId}/issues/${parentIssueId}/sub-issues`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'issues'] }),
	});
}

export interface IssueDependency {
	id: string;
	issue_id: string;
	blocked_by_issue_id: string;
	blocked_by_identifier: string;
	blocked_by_title: string;
	blocked_by_status: string;
	blocked_by_project_slug: string;
}

export function useIssueDependencies(teamId: string, issueId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'issues', issueId, 'dependencies'],
		queryFn: () =>
			api.get<IssueDependency[]>(`/api/teams/${teamId}/issues/${issueId}/dependencies`),
	});
}

export function useAddDependency(teamId: string, issueId: string) {
	return useMutation({
		mutationFn: (blockedByIssueId: string) =>
			api.post(`/api/teams/${teamId}/issues/${issueId}/dependencies`, {
				blocked_by_issue_id: blockedByIssueId,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'issues', issueId, 'dependencies'],
			}),
	});
}

export function useRemoveDependency(teamId: string, issueId: string) {
	return useMutation({
		mutationFn: (depId: string) =>
			api.delete(`/api/teams/${teamId}/issues/${issueId}/dependencies/${depId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'issues', issueId, 'dependencies'],
			}),
	});
}
