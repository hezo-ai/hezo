import { AgentAdminStatus, type AgentEffort } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation, useSimpleOptimisticUpdate } from './use-optimistic-mutation';

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
	run_timeout_min: number;
	daily_budget_cents: number;
	weekly_budget_cents: number;
	monthly_budget_cents: number;
	touches_code: boolean;
	runtime_status: string;
	admin_status: string;
	last_heartbeat_at: string | null;
	/** Computed: when the next scheduled heartbeat is due. Null when the agent is
	 *  off the schedule (disabled or budget-paused). */
	next_heartbeat_at: string | null;
	/** Computed: whether the agent has an actionable task right now. False when its
	 *  next heartbeat would fire but find nothing to do (so the UI shows a dash
	 *  instead of a countdown). */
	has_actionable_work: boolean;
	reports_to: string | null;
	reports_to_title: string | null;
	assigned_task_count: number;
	model_override_provider: string | null;
	model_override_model: string | null;
	created_at: string;
	/** True for HQ agents (CEO/Coach) surfaced as virtual members of this project. */
	is_instance?: boolean;
	/** True when the agent has a live chatbox (and thus a Chat history tab). CEO only today. */
	chat_enabled?: boolean;
	/** Optional custom avatar (signed URL); null/undefined when unset (falls back to initials). */
	icon_url?: string | null;
	icon_updated_at?: string | null;
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

export function useAgents(projectId: string, adminStatus?: string) {
	return useQuery({
		queryKey: queryKeys.projects.agentsFiltered(projectId, { admin_status: adminStatus }),
		queryFn: () =>
			api.get<Agent[]>(
				`/api/projects/${projectId}/agents`,
				adminStatus ? { admin_status: adminStatus } : undefined,
			),
		enabled: !!projectId,
		staleTime: 0,
	});
}

export function useAgent(projectId: string, agentId: string) {
	return useQuery({
		queryKey: queryKeys.projects.agent(projectId, agentId),
		queryFn: () => api.get<Agent>(`/api/projects/${projectId}/agents/${agentId}`),
	});
}

interface UpdateAgentVars {
	title?: string;
	role_description?: string;
	system_prompt?: string;
	system_prompt_change_summary?: string;
	reports_to?: string | null;
	daily_budget_cents?: number;
	weekly_budget_cents?: number;
	monthly_budget_cents?: number;
	heartbeat_interval_min?: number;
	run_timeout_min?: number;
	touches_code?: boolean;
	model_override_provider?: string | null;
	model_override_model?: string | null;
}

export function useUpdateAgent(projectId: string, agentId: string) {
	// system_prompt/_change_summary live in a separate doc cache, so they're
	// omitted from the optimistic apply on the agent entity.
	return useSimpleOptimisticUpdate<Agent, UpdateAgentVars>(
		`/api/projects/${projectId}/agents/${agentId}`,
		queryKeys.projects.agent(projectId, agentId),
		{
			omitOptimistic: ['system_prompt', 'system_prompt_change_summary'],
			// budgetStatus carries the per-agent window limits the Budget page reads,
			// so a cap edit here must refetch it (staleTime would otherwise serve the
			// old caps for up to a minute).
			invalidateOnSettled: [
				queryKeys.projects.agents(projectId),
				queryKeys.projects.agentSystemPrompt(projectId, agentId),
				queryKeys.projects.budgetStatus(projectId),
			],
			errorMessage: 'Failed to update agent',
		},
	);
}

export interface AgentIconResponse {
	icon_url: string | null;
	icon_updated_at: string | null;
}

/**
 * Seed an agent's icon fields into the detail cache from a server response and
 * invalidate the roster/org-chart/agent queries so every surface that renders
 * the avatar reflects the change. Response-driven (the server returns the signed
 * `icon_url`), not optimistic.
 */
function applyAgentIconToCaches(projectId: string, agentId: string, icon: AgentIconResponse) {
	queryClient.setQueryData<Agent>(queryKeys.projects.agent(projectId, agentId), (old) =>
		old ? { ...old, icon_url: icon.icon_url, icon_updated_at: icon.icon_updated_at } : old,
	);
	// `agents(projectId)` is a prefix of every `agentsFiltered` key, so this
	// invalidates the roster list regardless of the active admin_status filter.
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.agents(projectId) });
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.orgChart(projectId) });
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.agent(projectId, agentId) });
}

/** Upload (or replace) an agent's avatar. `blob` is the normalized square PNG. */
export function useUploadAgentIcon(projectId: string, agentId: string) {
	return useMutation<AgentIconResponse, ApiError, Blob>({
		mutationFn: (blob) => {
			const fd = new FormData();
			fd.set('file', blob, 'icon.png');
			return api.putForm<AgentIconResponse>(
				`/api/projects/${projectId}/agents/${agentId}/icon`,
				fd,
			);
		},
		onSuccess: (data) => applyAgentIconToCaches(projectId, agentId, data),
	});
}

export function useRemoveAgentIcon(projectId: string, agentId: string) {
	return useMutation<AgentIconResponse, ApiError, void>({
		mutationFn: () =>
			api.delete<AgentIconResponse>(`/api/projects/${projectId}/agents/${agentId}/icon`),
		onSuccess: () =>
			applyAgentIconToCaches(projectId, agentId, { icon_url: null, icon_updated_at: null }),
	});
}

export function useAgentSystemPrompt(projectId: string, agentId: string) {
	return useQuery({
		queryKey: queryKeys.projects.agentSystemPrompt(projectId, agentId),
		queryFn: () =>
			api.get<AgentSystemPromptDoc | null>(
				`/api/projects/${projectId}/agents/${agentId}/system-prompt`,
			),
		enabled: !!projectId && !!agentId,
	});
}

export function useAgentSystemPromptPreview(projectId: string, agentId: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.projects.agentSystemPromptPreview(projectId, agentId),
		queryFn: () =>
			api.get<{ content: string }>(
				`/api/projects/${projectId}/agents/${agentId}/system-prompt/preview`,
			),
		enabled: enabled && !!projectId && !!agentId,
	});
}

export function useAgentSystemPromptRevisions(projectId: string, agentId: string) {
	return useQuery({
		queryKey: queryKeys.projects.agentSystemPromptRevisions(projectId, agentId),
		queryFn: () =>
			api.get<AgentSystemPromptRevision[]>(
				`/api/projects/${projectId}/agents/${agentId}/system-prompt/revisions`,
			),
		enabled: !!projectId && !!agentId,
	});
}

export function useRestoreAgentSystemPrompt(projectId: string, agentId: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post(`/api/projects/${projectId}/agents/${agentId}/system-prompt/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.agentSystemPrompt(projectId, agentId),
			});
		},
	});
}

export function useDisableAgent(projectId: string) {
	return useOptimisticMutation<string, unknown, Agent>({
		mutationFn: (agentId) => api.post(`/api/projects/${projectId}/agents/${agentId}/disable`),
		queryKey: (agentId) => queryKeys.projects.agent(projectId, agentId),
		applyOptimistic: (current) =>
			current ? { ...current, admin_status: AgentAdminStatus.Disabled } : current,
		invalidateOnSettled: [queryKeys.projects.agents(projectId)],
		errorMessage: 'Failed to disable agent',
	});
}

export function useEnableAgent(projectId: string) {
	return useOptimisticMutation<string, unknown, Agent>({
		mutationFn: (agentId) => api.post(`/api/projects/${projectId}/agents/${agentId}/enable`),
		queryKey: (agentId) => queryKeys.projects.agent(projectId, agentId),
		applyOptimistic: (current) =>
			current ? { ...current, admin_status: AgentAdminStatus.Enabled } : current,
		invalidateOnSettled: [queryKeys.projects.agents(projectId)],
		errorMessage: 'Failed to enable agent',
	});
}

export function useOnboardAgent(projectId: string) {
	return useMutation({
		mutationFn: (data: {
			title: string;
			role_description?: string;
			system_prompt?: string;
			reports_to?: string;
			daily_budget_cents?: number;
			weekly_budget_cents?: number;
			monthly_budget_cents?: number;
			heartbeat_interval_min?: number;
			touches_code?: boolean;
		}) =>
			api.post<{
				agent: Agent | null;
				task: { id: string; identifier: string } | null;
				approval: { id: string } | null;
				bootstrap: boolean;
			}>(`/api/projects/${projectId}/agents/onboard`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.agents(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.tasks(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.approvals(projectId) });
		},
	});
}
