import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 60_000,
			retry: 1,
			refetchOnWindowFocus: false,
		},
	},
});

// TEMP debug: log every invalidate/refetch targeting a tasks query, with the
// caller stack, to pin what refetches the infinite list on CI shard-2.
for (const m of ['invalidateQueries', 'refetchQueries', 'resetQueries'] as const) {
	const orig = queryClient[m].bind(queryClient);
	// biome-ignore lint/suspicious/noExplicitAny: temporary diagnostic shim
	(queryClient as any)[m] = (...args: any[]) => {
		const key = JSON.stringify(args[0]?.queryKey ?? args[0] ?? 'ALL');
		if (key === '"ALL"' || /tasksInfinite|"tasks"/.test(key)) {
			console.warn(
				`[DBG] ${m} key=${key}\n${new Error().stack?.split('\n').slice(2, 7).join('\n')}`,
			);
		}
		return orig(...args);
	};
}
