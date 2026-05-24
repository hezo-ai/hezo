import { useQuery } from '@tanstack/react-query';
import { checkStatus } from '../lib/auth';

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
		queryKey: ['status'],
		queryFn: checkStatus,
		staleTime: 0,
		gcTime: 0,
		refetchOnMount: 'always',
		retry: (failureCount, error) => isRetryableStatusError(error) && failureCount < 40,
		retryDelay: 500,
	});
}
