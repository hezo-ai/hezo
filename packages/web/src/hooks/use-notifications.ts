import type { NotificationKind } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface NotificationItem {
	id: string;
	company_id: string;
	company_slug: string;
	company_name: string;
	recipient_member_user_id: string;
	kind: NotificationKind;
	payload: Record<string, unknown>;
	read_at: string | null;
	created_at: string;
	issue_id: string | null;
	issue_identifier: string | null;
	issue_title: string | null;
	project_slug: string | null;
	requester_name: string | null;
}

export function useNotifications(companyId: string, opts: { unreadOnly?: boolean } = {}) {
	const unreadOnly = opts.unreadOnly ?? false;
	return useQuery({
		queryKey: ['companies', companyId, 'notifications', { unreadOnly }],
		queryFn: () =>
			api.get<NotificationItem[]>(`/api/companies/${companyId}/notifications`, {
				unread_only: unreadOnly ? 'true' : 'false',
			}),
		enabled: companyId.length > 0,
	});
}

export function useAllNotifications(companyIds: string[], opts: { unreadOnly?: boolean } = {}) {
	const unreadOnly = opts.unreadOnly ?? false;
	return useQuery({
		queryKey: ['notifications', 'pending', companyIds, { unreadOnly }],
		queryFn: async () => {
			const results = await Promise.all(
				companyIds.map((id) =>
					api.get<NotificationItem[]>(`/api/companies/${id}/notifications`, {
						unread_only: unreadOnly ? 'true' : 'false',
					}),
				),
			);
			return results.flat();
		},
		enabled: companyIds.length > 0,
	});
}

function invalidateNotificationCaches(companyId: string) {
	queryClient.invalidateQueries({ queryKey: ['notifications'] });
	queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'notifications'] });
}

export function useMarkNotificationRead() {
	return useMutation({
		mutationFn: ({
			companyId,
			id,
			read = true,
		}: {
			companyId: string;
			id: string;
			read?: boolean;
		}) => api.patch(`/api/companies/${companyId}/notifications/${id}`, { read }),
		onSuccess: (_, { companyId }) => invalidateNotificationCaches(companyId),
	});
}

export function useMarkAllNotificationsRead() {
	return useMutation({
		mutationFn: ({ companyId }: { companyId: string }) =>
			api.post(`/api/companies/${companyId}/notifications/mark-all-read`, {}),
		onSuccess: (_, { companyId }) => invalidateNotificationCaches(companyId),
	});
}
