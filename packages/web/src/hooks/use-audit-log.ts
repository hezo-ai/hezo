import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface AuditEntry {
	id: string;
	team_id: string;
	actor_type: string;
	actor_member_id: string | null;
	actor_name: string | null;
	action: string;
	entity_type: string;
	entity_id: string | null;
	details: Record<string, unknown>;
	created_at: string;
}

export function useAuditLog(teamId: string, filters?: { entity_type?: string; action?: string }) {
	return useQuery({
		queryKey: ['teams', teamId, 'audit-log', filters],
		queryFn: () =>
			api.get<AuditEntry[]>(`/api/teams/${teamId}/audit-log`, {
				entity_type: filters?.entity_type,
				action: filters?.action,
				per_page: '50',
			}),
	});
}
