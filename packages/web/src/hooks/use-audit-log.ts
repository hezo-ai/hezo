import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface AuditEntry {
	id: string;
	project_id: string | null;
	actor_type: string;
	actor_member_id: string | null;
	actor_api_key_id: string | null;
	actor_name: string | null;
	project_slug: string | null;
	project_name: string | null;
	action: string;
	entity_type: string;
	entity_id: string | null;
	/** Identifier of the task when the row's entity is a task. */
	entity_identifier: string | null;
	/** Identifier of the task referenced via details.task_id (runs, assets, credentials). */
	ref_task_identifier: string | null;
	details: Record<string, unknown>;
	created_at: string;
}

type AuditFilters = { entity_type?: string; action?: string };

// Per-project view — a filtered slice of the instance log scoped to one project.
export function useProjectAuditLog(projectId: string, filters?: AuditFilters) {
	return useQuery({
		queryKey: queryKeys.projects.auditLog(projectId, filters),
		queryFn: () =>
			api.get<AuditEntry[]>(`/api/projects/${projectId}/audit-log`, {
				entity_type: filters?.entity_type,
				action: filters?.action,
				per_page: '50',
			}),
	});
}

// Instance-level view — every project plus instance-scoped (project_id NULL) rows.
// Superuser only; the un-prefixed /api/audit-log route enforces it.
export function useInstanceAuditLog(filters?: AuditFilters) {
	return useQuery({
		queryKey: queryKeys.instanceAuditLog(filters),
		queryFn: () =>
			api.get<AuditEntry[]>('/api/audit-log', {
				entity_type: filters?.entity_type,
				action: filters?.action,
				per_page: '100',
			}),
	});
}
