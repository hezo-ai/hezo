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

export function useGithubOrgs(teamId: string, enabled = true) {
	return useQuery({
		queryKey: ['teams', teamId, 'github', 'orgs'],
		queryFn: () => api.get<GithubOrg[]>(`/api/teams/${teamId}/github/orgs`),
		enabled,
	});
}

export function useGithubRepos(teamId: string, owner: string | null, query: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'github', 'repos', owner, query],
		queryFn: () =>
			api.get<GithubRepo[]>(
				`/api/teams/${teamId}/github/repos?owner=${encodeURIComponent(owner ?? '')}&query=${encodeURIComponent(query)}`,
			),
		enabled: !!owner,
	});
}
