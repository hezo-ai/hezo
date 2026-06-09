import type { AdminMentionItem } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export type { AdminMentionItem };

export function useAdminMentions(projectSlug: string, enabled = true) {
	return useQuery({
		queryKey: queryKeys.projects.inboxMentions(projectSlug),
		queryFn: () => api.get<AdminMentionItem[]>(`/api/projects/${projectSlug}/inbox/mentions`),
		enabled: enabled && !!projectSlug,
	});
}

export function useAllAdminMentions(projectSlugs: string[], { archived = false } = {}) {
	const projectKey = [...projectSlugs].sort().join(',');
	return useQuery({
		queryKey: queryKeys.inboxMentions.all(projectKey, { archived }),
		queryFn: async () => {
			const results = await Promise.all(
				projectSlugs.map((slug) =>
					api.get<AdminMentionItem[]>(`/api/projects/${slug}/inbox/mentions`, {
						archived: String(archived),
					}),
				),
			);
			return results.flat();
		},
		enabled: projectSlugs.length > 0,
		staleTime: 0,
	});
}

export function useMarkMentionRead() {
	return useMutation({
		mutationFn: ({ projectSlug, mentionId }: { projectSlug: string; mentionId: string }) =>
			api.post<{ id: string; read_at: string }>(
				`/api/projects/${projectSlug}/inbox/mentions/${mentionId}/read`,
				{},
			),
		onMutate: async ({ projectSlug, mentionId }) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.projects.inboxMentions(projectSlug) });
			await queryClient.cancelQueries({ queryKey: queryKeys.inboxMentions.root() });

			const teamSnapshot = queryClient.getQueryData<AdminMentionItem[]>([
				'teams',
				projectSlug,
				'inbox-mentions',
			]);
			const now = new Date().toISOString();
			if (teamSnapshot) {
				queryClient.setQueryData<AdminMentionItem[]>(
					queryKeys.projects.inboxMentions(projectSlug),
					teamSnapshot.map((m) => (m.id === mentionId ? { ...m, read_at: now } : m)),
				);
			}

			const aggregatedSnapshots: Array<[readonly unknown[], AdminMentionItem[] | undefined]> = [];
			const aggregated = queryClient.getQueriesData<AdminMentionItem[]>({
				queryKey: queryKeys.inboxMentions.root(),
			});
			for (const [key, data] of aggregated) {
				aggregatedSnapshots.push([key, data]);
				if (!data) continue;
				queryClient.setQueryData<AdminMentionItem[]>(
					key,
					data.map((m) => (m.id === mentionId ? { ...m, read_at: now } : m)),
				);
			}

			return { teamSnapshot, aggregatedSnapshots };
		},
		onError: (_err, { projectSlug }, ctx) => {
			if (ctx?.teamSnapshot) {
				queryClient.setQueryData(queryKeys.projects.inboxMentions(projectSlug), ctx.teamSnapshot);
			}
			for (const [key, data] of ctx?.aggregatedSnapshots ?? []) {
				queryClient.setQueryData(key, data);
			}
		},
		onSettled: (_data, _err, { projectSlug }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxMentions(projectSlug) });
			queryClient.invalidateQueries({ queryKey: queryKeys.inboxMentions.root() });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxCount(projectSlug) });
		},
	});
}

export function useMarkAllMentionsRead() {
	return useMutation({
		mutationFn: (projectSlug: string) =>
			api.post<{ marked_read: number }>(`/api/projects/${projectSlug}/inbox/mentions/read-all`, {}),
		onSuccess: (_data, projectSlug) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxMentions(projectSlug) });
			queryClient.invalidateQueries({ queryKey: queryKeys.inboxMentions.root() });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxCount(projectSlug) });
		},
	});
}
