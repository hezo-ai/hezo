import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CredentialUsage {
	id: string;
	company_id: string;
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

export function useCredentials(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'credentials'],
		queryFn: () => api.get<CredentialUsage[]>(`/api/companies/${companyId}/credentials`),
	});
}
