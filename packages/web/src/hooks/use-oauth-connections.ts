import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface OAuthConnection {
	id: string;
	provider: string;
	provider_account_id: string;
	provider_account_label: string;
	scopes: string[];
	expires_at: string | null;
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface DeviceFlowStart {
	flow_id: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

export interface DeviceFlowSuccess {
	status: 'success';
	connection: OAuthConnection;
}

export interface DeviceFlowPending {
	status: 'pending';
	retry_after: number;
}

export type DeviceFlowPollResult = DeviceFlowSuccess | DeviceFlowPending;

export function useOAuthConnections(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'oauth-connections'],
		queryFn: () => api.get<OAuthConnection[]>(`/api/teams/${teamId}/oauth-connections`),
	});
}

export function useDeleteOAuthConnection(teamId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/teams/${teamId}/oauth-connections/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'oauth-connections'],
			});
		},
	});
}

export function useStartGitHubDeviceFlow(teamId: string) {
	return useMutation({
		mutationFn: (scopes?: string[]) =>
			api.post<DeviceFlowStart>(`/api/teams/${teamId}/oauth/github/device-start`, {
				scopes: scopes ?? [],
			}),
	});
}

export interface ScopeStatus {
	sufficient: boolean;
	missing: string[];
	required: string[];
}

export function useConnectionScopeStatus(teamId: string, connectionId: string | null | undefined) {
	return useQuery({
		queryKey: ['teams', teamId, 'oauth-connections', connectionId, 'scope-status'],
		queryFn: () =>
			api.get<ScopeStatus>(`/api/teams/${teamId}/oauth-connections/${connectionId}/scope-status`),
		enabled: !!connectionId,
	});
}

export async function pollGitHubDeviceFlow(
	teamId: string,
	flowId: string,
): Promise<DeviceFlowPollResult> {
	const token = api.getToken();
	const res = await fetch(`/api/teams/${teamId}/oauth/github/device-poll`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ flow_id: flowId }),
	});
	const json = (await res.json()) as { data?: DeviceFlowPollResult; error?: { message: string } };
	if (!res.ok && res.status !== 202) {
		throw new Error(json.error?.message ?? `device poll failed (${res.status})`);
	}
	if (json.data?.status === 'success') {
		queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'oauth-connections'] });
	}
	return json.data as DeviceFlowPollResult;
}
