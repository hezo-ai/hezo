import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

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
		queryKey: ['projects', projectId, 'github', 'orgs'],
		queryFn: () => api.get<GithubOrg[]>(`/api/projects/${projectId}/github/orgs`),
		enabled,
	});
}

export function useGithubRepos(projectId: string, owner: string | null, query: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'github', 'repos', owner, query],
		queryFn: () =>
			api.get<GithubRepo[]>(
				`/api/projects/${projectId}/github/repos?owner=${encodeURIComponent(owner ?? '')}&query=${encodeURIComponent(query)}`,
			),
		enabled: !!owner,
	});
}
