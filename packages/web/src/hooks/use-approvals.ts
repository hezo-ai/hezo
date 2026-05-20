import { ApprovalStatus, type BlockedTicket } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Approval {
	id: string;
	team_id: string;
	type: string;
	status: string;
	payload: Record<string, unknown>;
	resolution_note: string | null;
	resolved_at: string | null;
	created_at: string;
	team_name: string;
	team_slug: string;
	requested_by_name: string | null;
	requested_by_member_id: string | null;
	payload_member_name: string | null;
	payload_member_slug: string | null;
	payload_project_name: string | null;
	payload_project_slug: string | null;
	payload_issue_identifier: string | null;
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

export function useAllPendingApprovals(teamIds: string[]) {
	return useQuery({
		queryKey: ['approvals', 'pending', teamIds],
		queryFn: async () => {
			const results = await Promise.all(
				teamIds.map((id) =>
					api.get<Approval[]>(`/api/teams/${id}/approvals`, {
						status: ApprovalStatus.Pending,
					}),
				),
			);
			return results.flat();
		},
		enabled: teamIds.length > 0,
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
		}) => api.post(`/api/approvals/${approvalId}/resolve`, { status, resolution_note }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approvals'] }),
	});
}
