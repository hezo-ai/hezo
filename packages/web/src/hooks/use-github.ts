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

export function useGithubOrgs(companyId: string, enabled = true) {
	return useQuery({
		queryKey: ['companies', companyId, 'github', 'orgs'],
		queryFn: () => api.get<GithubOrg[]>(`/api/companies/${companyId}/github/orgs`),
		enabled,
	});
}

export function useGithubRepos(companyId: string, owner: string | null, query: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'github', 'repos', owner, query],
		queryFn: () =>
			api.get<GithubRepo[]>(
				`/api/companies/${companyId}/github/repos?owner=${encodeURIComponent(owner ?? '')}&query=${encodeURIComponent(query)}`,
			),
		enabled: !!owner,
	});
}
