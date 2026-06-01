import type { BoardMentionItem } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export type { BoardMentionItem };

export function useBoardMentions(teamSlug: string, enabled = true) {
	return useQuery({
		queryKey: ['teams', teamSlug, 'inbox-mentions'],
		queryFn: () => api.get<BoardMentionItem[]>(`/api/teams/${teamSlug}/inbox/mentions`),
		enabled: enabled && !!teamSlug,
	});
}

export function useAllBoardMentions(teamSlugs: string[], { archived = false } = {}) {
	const teamKey = [...teamSlugs].sort().join(',');
	return useQuery({
		queryKey: ['inbox-mentions', teamKey, { archived }],
		queryFn: async () => {
			const results = await Promise.all(
				teamSlugs.map((slug) =>
					api.get<BoardMentionItem[]>(`/api/teams/${slug}/inbox/mentions`, {
						archived: String(archived),
					}),
				),
			);
			return results.flat();
		},
		enabled: teamSlugs.length > 0,
		staleTime: 0,
	});
}

export function useMarkMentionRead() {
	return useMutation({
		mutationFn: ({ teamSlug, mentionId }: { teamSlug: string; mentionId: string }) =>
			api.post<{ id: string; read_at: string }>(
				`/api/teams/${teamSlug}/inbox/mentions/${mentionId}/read`,
				{},
			),
		onMutate: async ({ teamSlug, mentionId }) => {
			await queryClient.cancelQueries({ queryKey: ['teams', teamSlug, 'inbox-mentions'] });
			await queryClient.cancelQueries({ queryKey: ['inbox-mentions'] });

			const teamSnapshot = queryClient.getQueryData<BoardMentionItem[]>([
				'teams',
				teamSlug,
				'inbox-mentions',
			]);
			const now = new Date().toISOString();
			if (teamSnapshot) {
				queryClient.setQueryData<BoardMentionItem[]>(
					['teams', teamSlug, 'inbox-mentions'],
					teamSnapshot.map((m) => (m.id === mentionId ? { ...m, read_at: now } : m)),
				);
			}

			const aggregatedSnapshots: Array<[readonly unknown[], BoardMentionItem[] | undefined]> = [];
			const aggregated = queryClient.getQueriesData<BoardMentionItem[]>({
				queryKey: ['inbox-mentions'],
			});
			for (const [key, data] of aggregated) {
				aggregatedSnapshots.push([key, data]);
				if (!data) continue;
				queryClient.setQueryData<BoardMentionItem[]>(
					key,
					data.map((m) => (m.id === mentionId ? { ...m, read_at: now } : m)),
				);
			}

			return { teamSnapshot, aggregatedSnapshots };
		},
		onError: (_err, { teamSlug }, ctx) => {
			if (ctx?.teamSnapshot) {
				queryClient.setQueryData(['teams', teamSlug, 'inbox-mentions'], ctx.teamSnapshot);
			}
			for (const [key, data] of ctx?.aggregatedSnapshots ?? []) {
				queryClient.setQueryData(key, data);
			}
		},
		onSettled: (_data, _err, { teamSlug }) => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamSlug, 'inbox-mentions'] });
			queryClient.invalidateQueries({ queryKey: ['inbox-mentions'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamSlug, 'inbox-count'] });
		},
	});
}

export function useMarkAllMentionsRead() {
	return useMutation({
		mutationFn: (teamSlug: string) =>
			api.post<{ marked_read: number }>(`/api/teams/${teamSlug}/inbox/mentions/read-all`, {}),
		onSuccess: (_data, teamSlug) => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamSlug, 'inbox-mentions'] });
			queryClient.invalidateQueries({ queryKey: ['inbox-mentions'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamSlug, 'inbox-count'] });
		},
	});
}
