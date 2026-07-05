import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface DatabaseInfo {
	backend: 'embedded' | 'external';
	/**
	 * Server-side redacted display string — the pgdata path (embedded) or the
	 * occluded connection URL (external). The raw URL never reaches the client.
	 */
	display: string;
	server_version?: string;
}

/** Superuser-only endpoint — pass `enabled: false` for other users to avoid a 403 fetch. */
export function useDatabaseInfo(enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.databaseInfo(),
		queryFn: () => api.get<DatabaseInfo>('/api/database-info'),
		enabled,
	});
}
