import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface SandboxBackendInfo {
	backend: 'docker' | 'daytona';
	/**
	 * Server-side redacted display string - the provider endpoint for a managed
	 * backend. The API key never reaches the client.
	 */
	display: string;
}

/** Superuser-only endpoint - pass `enabled: false` for other users to avoid a 403 fetch. */
export function useSandboxBackendInfo(enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.sandboxBackendInfo(),
		queryFn: () => api.get<SandboxBackendInfo>('/api/sandbox-backend-info'),
		enabled,
	});
}
