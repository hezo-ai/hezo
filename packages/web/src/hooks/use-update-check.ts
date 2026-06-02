import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface UpdateInfo {
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	url: string | null;
}

/**
 * Poll the server's GitHub-Releases check. The server caches upstream for an
 * hour and fails soft, so this is cheap and never errors the shell.
 */
export function useUpdateCheck() {
	return useQuery({
		queryKey: ['update-check'],
		queryFn: () => api.get<UpdateInfo>('/api/updates/latest'),
		staleTime: 60 * 60 * 1000,
		gcTime: 60 * 60 * 1000,
		retry: false,
	});
}
