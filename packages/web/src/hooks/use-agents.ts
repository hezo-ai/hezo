import type { AgentEffort } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Agent {
	id: string;
	team_id: string;
	display_name: string;
	title: string;
	slug: string;
	role_description: string | null;
	summary: string | null;
	team_context: string | null;
	default_effort: AgentEffort;
	heartbeat_interval_min: number;
	monthly_budget_cents: number;
	budget_used_cents: number;
	touches_code: boolean;
	budget_reset_at: string | null;
	runtime_status: string;
	admin_status: string;
	last_heartbeat_at: string | null;
	reports_to: string | null;
	reports_to_title: string | null;
	assigned_issue_count: number;
	model_override_provider: string | null;
	model_override_model: string | null;
	created_at: string;
}

export interface AgentSystemPromptDoc {
	id: string;
	content: string;
	title: string;
	last_updated_by_member_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface AgentSystemPromptRevision {
	id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	author_name: string | null;
	created_at: string;
}

export function useAgents(teamId: string, adminStatus?: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'agents', { admin_status: adminStatus }],
		queryFn: () =>
			api.get<Agent[]>(
				`/api/teams/${teamId}/agents`,
				adminStatus ? { admin_status: adminStatus } : undefined,
			),
		enabled: !!teamId,
		staleTime: 0,
	});
}

export function useAgent(teamId: string, agentId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'agents', agentId],
		queryFn: () => api.get<Agent>(`/api/teams/${teamId}/agents/${agentId}`),
	});
}

export function useUpdateAgent(teamId: string, agentId: string) {
	return useMutation({
		mutationFn: (data: {
			title?: string;
			role_description?: string;
			system_prompt?: string;
			system_prompt_change_summary?: string;
			reports_to?: string | null;
			monthly_budget_cents?: number;
			heartbeat_interval_min?: number;
			touches_code?: boolean;
			model_override_provider?: string | null;
			model_override_model?: string | null;
		}) => api.patch<Agent>(`/api/teams/${teamId}/agents/${agentId}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'agents'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'agents', agentId] });
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'agents', agentId, 'system-prompt'],
			});
		},
	});
}

export function useAgentSystemPrompt(teamId: string, agentId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'agents', agentId, 'system-prompt'],
		queryFn: () =>
			api.get<AgentSystemPromptDoc | null>(`/api/teams/${teamId}/agents/${agentId}/system-prompt`),
		enabled: !!teamId && !!agentId,
	});
}

export function useAgentSystemPromptPreview(teamId: string, agentId: string, enabled: boolean) {
	return useQuery({
		queryKey: ['teams', teamId, 'agents', agentId, 'system-prompt', 'preview'],
		queryFn: () =>
			api.get<{ content: string }>(`/api/teams/${teamId}/agents/${agentId}/system-prompt/preview`),
		enabled: enabled && !!teamId && !!agentId,
	});
}

export function useAgentSystemPromptRevisions(teamId: string, agentId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'agents', agentId, 'system-prompt', 'revisions'],
		queryFn: () =>
			api.get<AgentSystemPromptRevision[]>(
				`/api/teams/${teamId}/agents/${agentId}/system-prompt/revisions`,
			),
		enabled: !!teamId && !!agentId,
	});
}

export function useRestoreAgentSystemPrompt(teamId: string, agentId: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post(`/api/teams/${teamId}/agents/${agentId}/system-prompt/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'agents', agentId, 'system-prompt'],
			});
		},
	});
}

export function useDisableAgent(teamId: string) {
	return useMutation({
		mutationFn: (agentId: string) => api.post(`/api/teams/${teamId}/agents/${agentId}/disable`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'agents'] }),
	});
}

export function useEnableAgent(teamId: string) {
	return useMutation({
		mutationFn: (agentId: string) => api.post(`/api/teams/${teamId}/agents/${agentId}/enable`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'agents'] }),
	});
}

export function useOnboardAgent(teamId: string) {
	return useMutation({
		mutationFn: (data: {
			title: string;
			role_description?: string;
			system_prompt?: string;
			monthly_budget_cents?: number;
			heartbeat_interval_min?: number;
			touches_code?: boolean;
		}) =>
			api.post<{
				agent: Agent | null;
				issue: { id: string; identifier: string } | null;
				approval: { id: string } | null;
				bootstrap: boolean;
			}>(`/api/teams/${teamId}/agents/onboard`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'agents'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'issues'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'approvals'] });
		},
	});
}
