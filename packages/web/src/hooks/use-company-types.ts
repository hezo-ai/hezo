import type { CompanyTypeSource } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CompanyTypeAgentType {
	agent_type_id: string;
	name: string;
	slug: string;
	role_description: string;
	runtime_type: string;
	reports_to_slug: string | null;
	sort_order: number;
}

export interface CompanyType {
	id: string;
	name: string;
	description: string | null;
	is_builtin: boolean;
	source: CompanyTypeSource;
	metadata: Record<string, unknown>;
	kb_docs_config: Array<{ title: string; slug: string; content: string }>;
	agent_types: CompanyTypeAgentType[];
	created_at: string;
}

export function useCompanyTypes() {
	return useQuery({
		queryKey: ['company-types'],
		queryFn: () => api.get<CompanyType[]>('/api/company-types'),
	});
}
