import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface AuditEntry {
	id: string;
	company_id: string;
	actor_type: string;
	actor_member_id: string | null;
	actor_name: string | null;
	action: string;
	entity_type: string;
	entity_id: string | null;
	details: Record<string, unknown>;
	created_at: string;
}

export function useAuditLog(
	companyId: string,
	filters?: { entity_type?: string; action?: string },
) {
	return useQuery({
		queryKey: ['companies', companyId, 'audit-log', filters],
		queryFn: () =>
			api.get<AuditEntry[]>(`/api/companies/${companyId}/audit-log`, {
				entity_type: filters?.entity_type,
				action: filters?.action,
				per_page: '50',
			}),
	});
}
