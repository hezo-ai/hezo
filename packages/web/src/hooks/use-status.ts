import { useQuery } from '@tanstack/react-query';
import { checkStatus } from '../lib/auth';

export function useStatus() {
	return useQuery({
		queryKey: ['status'],
		queryFn: checkStatus,
		staleTime: 0,
		retry: false,
	});
}
