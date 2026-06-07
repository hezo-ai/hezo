import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface AuditEntry {
	id: string;
	team_id: string | null;
	project_id: string | null;
	actor_type: string;
	actor_member_id: string | null;
	actor_name: string | null;
	team_name: string | null;
	team_slug: string | null;
	project_slug: string | null;
	/** Slug of the team's internal project, the anchor for team-level settings pages. */
	team_internal_slug: string | null;
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

// Team-scoped view (the project's backing team), addressed via the project.
export function useAuditLog(projectId: string, filters?: AuditFilters) {
	return useQuery({
		queryKey: ['projects', projectId, 'team-audit-log', filters],
		queryFn: () =>
			api.get<AuditEntry[]>(`/api/projects/${projectId}/team-audit-log`, {
				entity_type: filters?.entity_type,
				action: filters?.action,
				per_page: '50',
			}),
	});
}

// Per-project view — a filtered slice of the instance log scoped to one project.
export function useProjectAuditLog(projectId: string, filters?: AuditFilters) {
	return useQuery({
		queryKey: ['projects', projectId, 'audit-log', filters],
		queryFn: () =>
			api.get<AuditEntry[]>(`/api/projects/${projectId}/audit-log`, {
				entity_type: filters?.entity_type,
				action: filters?.action,
				per_page: '50',
			}),
	});
}

// Instance-level view — every team plus instance-scoped (team_id NULL) rows.
// Superuser only; the un-prefixed /api/audit-log route enforces it.
export function useInstanceAuditLog(filters?: AuditFilters) {
	return useQuery({
		queryKey: ['instance', 'audit-log', filters],
		queryFn: () =>
			api.get<AuditEntry[]>('/api/audit-log', {
				entity_type: filters?.entity_type,
				action: filters?.action,
				per_page: '100',
			}),
	});
}
