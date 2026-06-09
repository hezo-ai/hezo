import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface CredentialUsage {
	id: string;
	team_id: string;
	project_id: string | null;
	name: string;
	category: string;
	allowed_hosts: string[];
	allow_all_hosts: boolean;
	created_at: string;
	updated_at: string;
	project_name: string | null;
	last_used_at: string | null;
	use_count: number;
	last_host: string | null;
}

export function useCredentials(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.credentials(projectId),
		queryFn: () => api.get<CredentialUsage[]>(`/api/projects/${projectId}/credentials`),
	});
}
