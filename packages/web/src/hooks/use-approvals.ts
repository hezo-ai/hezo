import { ApprovalStatus, type BlockedTicket } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
	invalidateAllTeamAgentCaches,
	invalidateTeamAgentCaches,
} from '../lib/invalidate-team-caches';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

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
	requested_by_slug: string | null;
	/**
	 * The requester's uploaded avatar, or null. The built-in CEO/Coach default is
	 * resolved client-side from `requested_by_slug`; this only carries the upload.
	 */
	requested_by_icon_url: string | null;
	requested_by_avatar_spec?: unknown;
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
		queryKey: queryKeys.projects.approvalsFiltered(projectId, { status }),
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
		queryKey: queryKeys.approvals.all(projectKey, { archived }),
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
		queryKey: queryKeys.projects.approvalBlockedTickets(projectId, approvalId),
		queryFn: () =>
			api.get<BlockedTicket[]>(
				`/api/projects/${projectId}/approvals/${approvalId}/blocked-tickets`,
			),
		enabled: enabled && !!approvalId && !!projectId,
	});
}

// Approval mutations touch the same caches: the cross-project aggregated lists,
// and (per project) the approvals list, inbox count, and agent caches.
function invalidateApprovalCaches(projectSlug?: string) {
	queryClient.invalidateQueries({ queryKey: queryKeys.approvals.root() });
	if (projectSlug) {
		queryClient.invalidateQueries({ queryKey: queryKeys.projects.approvals(projectSlug) });
		queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxCount(projectSlug) });
		invalidateTeamAgentCaches(queryClient, projectSlug);
	} else {
		// No project scope — match any project's approvals list and inbox count,
		// keyed `['projects', <slug>, 'approvals' | 'inbox-count']`.
		queryClient.invalidateQueries({
			predicate: (query) =>
				Array.isArray(query.queryKey) &&
				query.queryKey[0] === 'projects' &&
				typeof query.queryKey[1] === 'string' &&
				(query.queryKey[2] === 'approvals' || query.queryKey[2] === 'inbox-count'),
		});
		invalidateAllTeamAgentCaches(queryClient);
	}
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
		onSuccess: (_data, variables) => invalidateApprovalCaches(variables.projectSlug),
	});
}

export interface HireProposalEdits {
	title?: string;
	role_description?: string;
	system_prompt?: string;
	reports_to?: string;
	heartbeat_interval_min?: number;
	daily_budget_cents?: number;
	weekly_budget_cents?: number;
	monthly_budget_cents?: number;
	touches_code?: boolean;
}

/** Admin edits to a pending hire proposal's spec before approving it. */
export function useUpdateHireProposal() {
	return useMutation({
		mutationFn: ({
			approvalId,
			edits,
		}: {
			approvalId: string;
			edits: HireProposalEdits;
			projectSlug?: string;
		}) => api.patch<Approval>(`/api/approvals/${approvalId}`, edits),
		onSuccess: (_data, variables) => invalidateApprovalCaches(variables.projectSlug),
	});
}
