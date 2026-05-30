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

export interface AuthStartAuthCode {
	flow: 'auth_code';
	auth_url: string;
}

export interface AuthStartDevice {
	flow: 'device';
	flow_id: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

export type AuthStartResult = AuthStartAuthCode | AuthStartDevice;

export interface AuthPollSuccess {
	status: 'success';
	connection: OAuthConnection;
}

export interface AuthPollPending {
	status: 'pending';
	retry_after: number;
}

export type AuthPollResult = AuthPollSuccess | AuthPollPending;

export interface AuthStartBody {
	connector_id?: string;
	provider?: 'github';
	scopes?: string[];
}

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

export function useAuthStart(teamId: string) {
	return useMutation({
		mutationFn: (body: AuthStartBody) =>
			api.post<AuthStartResult>(`/api/teams/${teamId}/auth-start`, body),
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

export async function pollAuth(teamId: string, flowId: string): Promise<AuthPollResult> {
	const token = api.getToken();
	const res = await fetch(`/api/teams/${teamId}/auth-poll`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ flow_id: flowId }),
	});
	const json = (await res.json()) as { data?: AuthPollResult; error?: { message: string } };
	if (!res.ok && res.status !== 202) {
		throw new Error(json.error?.message ?? `auth poll failed (${res.status})`);
	}
	if (json.data?.status === 'success') {
		queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'oauth-connections'] });
	}
	return json.data as AuthPollResult;
}
