import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Approval {
	id: string;
	company_id: string;
	type: string;
	status: string;
	payload: Record<string, unknown>;
	resolution_note: string | null;
	resolved_at: string | null;
	created_at: string;
	company_name: string;
	requested_by_name: string | null;
	requested_by_member_id: string | null;
}

export function useApprovals(companyId: string, status = 'pending') {
	return useQuery({
		queryKey: ['companies', companyId, 'approvals', { status }],
		queryFn: () => api.get<Approval[]>(`/api/companies/${companyId}/approvals`, { status }),
	});
}

export function useAllPendingApprovals(companyIds: string[]) {
	return useQuery({
		queryKey: ['approvals', 'pending', companyIds],
		queryFn: async () => {
			const results = await Promise.all(
				companyIds.map((id) =>
					api.get<Approval[]>(`/api/companies/${id}/approvals`, { status: 'pending' }),
				),
			);
			return results.flat();
		},
		enabled: companyIds.length > 0,
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
			status: 'approved' | 'denied';
			resolution_note?: string;
		}) => api.post(`/api/approvals/${approvalId}/resolve`, { status, resolution_note }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approvals'] }),
	});
}
