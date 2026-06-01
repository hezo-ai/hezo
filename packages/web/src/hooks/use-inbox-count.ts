import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useInboxUnreadCount(teamSlug: string, enabled = true) {
	return useQuery({
		queryKey: ['teams', teamSlug, 'inbox-count'],
		queryFn: () => api.get<{ unread: number }>(`/api/teams/${teamSlug}/inbox/count`),
		enabled: enabled && !!teamSlug,
	});
}
