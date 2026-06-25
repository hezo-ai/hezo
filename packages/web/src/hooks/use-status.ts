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
		// While the server reports it's still booting, keep polling so the loading
		// screen advances through phases and flips to the app the moment it's ready.
		refetchInterval: (query) => (query.state.data?.starting ? 500 : false),
	});
}
