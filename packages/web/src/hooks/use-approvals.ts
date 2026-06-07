import { ApprovalStatus, type BlockedTicket } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
	invalidateAllTeamAgentCaches,
	invalidateTeamAgentCaches,
} from '../lib/invalidate-team-caches';
import { queryClient } from '../lib/query-client';

export interface Approval {
	id: string;
	team_id: string;
	type: string;
	status: string;
	payload: Record<string, unknown>;
	resolution_note: string | null;
	resolved_at: string | null;
	archived_at: string | null;
	created_at: string;
	team_name: string;
	team_slug: string;
	requested_by_name: string | null;
	requested_by_member_id: string | null;
	payload_member_name: string | null;
	payload_member_slug: string | null;
	payload_project_name: string | null;
	payload_project_slug: string | null;
	payload_task_identifier: string | null;
}

export function useApprovals(
	projectId: string,
	status: string = ApprovalStatus.Pending,
	enabled = true,
) {
	return useQuery({
		queryKey: ['projects', projectId, 'approvals', { status }],
		queryFn: () => api.get<Approval[]>(`/api/projects/${projectId}/approvals`, { status }),
		enabled,
	});
}

const ALL_APPROVAL_STATUSES = [
	ApprovalStatus.Pending,
	ApprovalStatus.Approved,
	ApprovalStatus.Denied,
].join(',');

export function useAllApprovals(projectSlugs: string[], { archived = false } = {}) {
	const projectKey = [...projectSlugs].sort().join(',');
	return useQuery({
		queryKey: ['approvals', 'all', projectKey, { archived }],
		queryFn: async () => {
			const results = await Promise.all(
				projectSlugs.map((slug) =>
					api.get<Approval[]>(`/api/projects/${slug}/approvals`, {
						status: ALL_APPROVAL_STATUSES,
						archived: String(archived),
					}),
				),
			);
			return results.flat();
		},
		enabled: projectSlugs.length > 0,
		staleTime: 0,
	});
}

export function useBlockedTickets(
	projectId: string | null | undefined,
	approvalId: string | null | undefined,
	enabled = true,
) {
	return useQuery({
		queryKey: ['projects', projectId, 'approvals', approvalId, 'blocked-tickets'],
		queryFn: () =>
			api.get<BlockedTicket[]>(
				`/api/projects/${projectId}/approvals/${approvalId}/blocked-tickets`,
			),
		enabled: enabled && !!approvalId && !!projectId,
	});
}

export function useResolveApproval() {
	return useMutation({
		mutationFn: ({
			approvalId,
			status,
			resolution_note,
		}: {
			approvalId: string;
			status: typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied;
			resolution_note?: string;
			projectSlug?: string;
		}) => api.post(`/api/approvals/${approvalId}/resolve`, { status, resolution_note }),
		onSuccess: (_data, variables) => {
			// Always invalidate the cross-project aggregated lists — they have no project scope.
			queryClient.invalidateQueries({ queryKey: ['approvals'] });
			if (variables.projectSlug) {
				queryClient.invalidateQueries({
					queryKey: ['projects', variables.projectSlug, 'approvals'],
				});
				queryClient.invalidateQueries({
					queryKey: ['projects', variables.projectSlug, 'inbox-count'],
				});
				invalidateTeamAgentCaches(queryClient, variables.projectSlug);
			} else {
				// No project scope provided — fall back to a predicate that matches any project's
				// approvals list and inbox count, keyed `['projects', <slug>, 'approvals' | 'inbox-count']`.
				queryClient.invalidateQueries({
					predicate: (query) =>
						Array.isArray(query.queryKey) &&
						query.queryKey[0] === 'projects' &&
						typeof query.queryKey[1] === 'string' &&
						(query.queryKey[2] === 'approvals' || query.queryKey[2] === 'inbox-count'),
				});
				invalidateAllTeamAgentCaches(queryClient);
			}
		},
	});
}
