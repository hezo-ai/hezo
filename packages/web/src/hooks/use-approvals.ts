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
	teamId: string,
	status: string = ApprovalStatus.Pending,
	enabled = true,
) {
	return useQuery({
		queryKey: ['teams', teamId, 'approvals', { status }],
		queryFn: () => api.get<Approval[]>(`/api/teams/${teamId}/approvals`, { status }),
		enabled,
	});
}

const ALL_APPROVAL_STATUSES = [
	ApprovalStatus.Pending,
	ApprovalStatus.Approved,
	ApprovalStatus.Denied,
].join(',');

export function useAllApprovals(teamSlugs: string[], { archived = false } = {}) {
	const teamKey = [...teamSlugs].sort().join(',');
	return useQuery({
		queryKey: ['approvals', 'all', teamKey, { archived }],
		queryFn: async () => {
			const results = await Promise.all(
				teamSlugs.map((slug) =>
					api.get<Approval[]>(`/api/teams/${slug}/approvals`, {
						status: ALL_APPROVAL_STATUSES,
						archived: String(archived),
					}),
				),
			);
			return results.flat();
		},
		enabled: teamSlugs.length > 0,
		staleTime: 0,
	});
}

export function useBlockedTickets(
	teamId: string,
	approvalId: string | null | undefined,
	enabled = true,
) {
	return useQuery({
		queryKey: ['teams', teamId, 'approvals', approvalId, 'blocked-tickets'],
		queryFn: () =>
			api.get<BlockedTicket[]>(`/api/teams/${teamId}/approvals/${approvalId}/blocked-tickets`),
		enabled: enabled && !!approvalId,
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
			teamSlug?: string;
		}) => api.post(`/api/approvals/${approvalId}/resolve`, { status, resolution_note }),
		onSuccess: (_data, variables) => {
			// Always invalidate the cross-team aggregated lists — they have no team scope.
			queryClient.invalidateQueries({ queryKey: ['approvals'] });
			if (variables.teamSlug) {
				queryClient.invalidateQueries({
					queryKey: ['teams', variables.teamSlug, 'approvals'],
				});
				queryClient.invalidateQueries({
					queryKey: ['teams', variables.teamSlug, 'inbox-count'],
				});
				invalidateTeamAgentCaches(queryClient, variables.teamSlug);
			} else {
				// No team scope provided — fall back to a predicate that matches any team's
				// approvals list and inbox count, keyed `['teams', <slug>, 'approvals' | 'inbox-count']`.
				queryClient.invalidateQueries({
					predicate: (query) =>
						Array.isArray(query.queryKey) &&
						query.queryKey[0] === 'teams' &&
						typeof query.queryKey[1] === 'string' &&
						(query.queryKey[2] === 'approvals' || query.queryKey[2] === 'inbox-count'),
				});
				invalidateAllTeamAgentCaches(queryClient);
			}
		},
	});
}
