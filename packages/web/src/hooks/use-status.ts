import { useQuery } from '@tanstack/react-query';
import { checkStatus } from '../lib/auth';
import { queryKeys } from '../lib/query-keys';

function isRetryableStatusError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return (
		msg.includes('STARTING') ||
		msg.includes('503') ||
		msg.includes('Invalid status') ||
		msg.includes('Status request failed')
	);
}

export function useStatus() {
	return useQuery({
		queryKey: queryKeys.status(),
		queryFn: checkStatus,
		staleTime: 0,
		gcTime: 0,
		refetchOnMount: 'always',
		retry: (failureCount, error) => isRetryableStatusError(error) && failureCount < 40,
		retryDelay: 500,
		// Keep polling in two cases so the gate self-heals without user action:
		//   - while the server reports it's still booting, so the loading screen
		//     advances through phases and flips to the app the moment it's ready;
		//   - while the last fetch errored (e.g. a cold load with the server
		//     unreachable — a network "Failed to fetch" isn't retryable above and
		//     fails fast to `error`), so the moment the server comes back a poll
		//     succeeds and the shell renders, instead of stranding the user on the
		//     full-screen error. Healthy operation still never polls.
		refetchInterval: (query) => {
			if (query.state.data?.starting) return 500;
			if (query.state.status === 'error') return 2000;
			return false;
		},
	});
}
