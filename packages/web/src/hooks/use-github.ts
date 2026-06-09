import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface GithubOrg {
	login: string;
	avatar_url: string;
	is_personal: boolean;
}

export interface GithubRepo {
	id: number;
	name: string;
	full_name: string;
	owner: { login: string };
	private: boolean;
	default_branch: string;
}

export function useGithubOrgs(projectId: string, enabled = true) {
	return useQuery({
		queryKey: queryKeys.projects.githubOrgs(projectId),
		queryFn: () => api.get<GithubOrg[]>(`/api/projects/${projectId}/github/orgs`),
		enabled,
	});
}

export function useGithubRepos(projectId: string, owner: string | null, query: string) {
	return useQuery({
		queryKey: queryKeys.projects.githubRepos(projectId, owner, query),
		queryFn: () =>
			api.get<GithubRepo[]>(
				`/api/projects/${projectId}/github/repos?owner=${encodeURIComponent(owner ?? '')}&query=${encodeURIComponent(query)}`,
			),
		enabled: !!owner,
	});
}
