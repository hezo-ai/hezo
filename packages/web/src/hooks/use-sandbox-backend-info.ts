import type { SandboxBackend } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

/** What a backend switch would destroy, so the confirmation can name real numbers. */
export interface SandboxSwitchImpact {
	containers: number;
	activeRuns: number;
}

export interface SandboxBackendInfo {
	backend: SandboxBackend;
	/**
	 * Server-side redacted display string - the provider endpoint for a managed
	 * backend. The API key never reaches the client.
	 */
	display: string;
	/** Backends this build can switch to. */
	available: SandboxBackend[];
	/**
	 * Whether a provider credential is already saved. The key itself is never
	 * returned; this is only enough to offer "keep the saved key" instead of
	 * demanding one on every switch.
	 */
	credential_configured: boolean;
	/**
	 * The deployer fixed which backend this instance runs on, so the switch is
	 * refused with a 409. Renders the control locked rather than letting someone
	 * discover that by trying.
	 */
	backend_pinned: boolean;
	impact: SandboxSwitchImpact;
	/** Present only on the response to a switch. */
	containers_destroyed?: number;
}

/** Superuser-only endpoint - pass `enabled: false` for other users to avoid a 403 fetch. */
export function useSandboxBackendInfo(enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.sandboxBackendInfo(),
		queryFn: () => api.get<SandboxBackendInfo>('/api/sandbox-backend-info'),
		enabled,
	});
}

export interface SwitchBackendInput {
	backend: SandboxBackend;
	daytona_api_key?: string;
	daytona_api_url?: string;
}

/**
 * Response-driven, not optimistic, and deliberately so: the server preflights the
 * destination and only then destroys containers, so the outcome is not something
 * the UI can predict. Showing the new backend before the switch has actually
 * landed would claim a migration that may have been refused.
 *
 * Invalidates the instance settings too - the memory budget is derived from the
 * backend, so switching re-sizes it and the figure on screen goes stale.
 */
export function useSwitchSandboxBackend() {
	return useMutation({
		mutationFn: (input: SwitchBackendInput) =>
			api.patch<SandboxBackendInfo>('/api/sandbox-backend', input),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.sandboxBackendInfo(), data);
			queryClient.invalidateQueries({ queryKey: queryKeys.instanceSettings() });
			// Every project's container is gone, so anything showing container state
			// is now describing something that no longer exists.
			queryClient.invalidateQueries();
		},
	});
}
