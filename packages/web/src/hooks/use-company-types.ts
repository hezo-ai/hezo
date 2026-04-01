import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CompanyType {
	id: string;
	name: string;
	description: string | null;
	is_builtin: boolean;
	created_at: string;
}

export function useCompanyTypes() {
	return useQuery({
		queryKey: ['company-types'],
		queryFn: () => api.get<CompanyType[]>('/api/company-types'),
	});
}
