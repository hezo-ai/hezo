import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import type { Repo } from './use-projects';

export interface CreateRepoPayload {
	short_name: string;
	mode?: 'link' | 'create';
	url?: string;
	owner?: string;
	name?: string;
	private?: boolean;
	oauth_connection_id: string;
}

export function useRepos(projectId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'repos'],
		queryFn: () => api.get<Repo[]>(`/api/projects/${projectId}/repos`),
	});
}

export function useCreateRepo(projectId: string) {
	return useMutation({
		mutationFn: (data: CreateRepoPayload) =>
			api.post<Repo>(`/api/projects/${projectId}/repos`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'repos'] });
		},
	});
}

export function useDeleteRepo(projectId: string) {
	return useMutation({
		mutationFn: (repoId: string) => api.delete(`/api/projects/${projectId}/repos/${repoId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'repos'] });
		},
	});
}

export interface GitHubOrgSummary {
	login: string;
	avatar_url: string;
	is_personal: boolean;
}

export interface GitHubRepoSummary {
	id: number;
	name: string;
	full_name: string;
	owner: { login: string };
	private: boolean;
	default_branch: string;
	clone_url: string;
	ssh_url: string;
}

export function useGitHubOrgs(projectId: string, oauthConnectionId: string | null | undefined) {
	return useQuery({
		queryKey: ['projects', projectId, 'oauth-connections', oauthConnectionId, 'orgs'],
		queryFn: () =>
			api.get<GitHubOrgSummary[]>(
				`/api/projects/${projectId}/oauth-connections/${oauthConnectionId}/orgs`,
			),
		enabled: !!oauthConnectionId,
	});
}

export function useGitHubReposForOwner(
	projectId: string,
	oauthConnectionId: string | null | undefined,
	owner: string | null,
	query: string,
) {
	return useQuery({
		queryKey: [
			'projects',
			projectId,
			'oauth-connections',
			oauthConnectionId,
			'repos',
			owner,
			query,
		],
		queryFn: () => {
			const params = new URLSearchParams({ owner: owner ?? '' });
			if (query) params.set('q', query);
			return api.get<GitHubRepoSummary[]>(
				`/api/projects/${projectId}/oauth-connections/${oauthConnectionId}/repos?${params}`,
			);
		},
		enabled: !!oauthConnectionId && !!owner,
	});
}
