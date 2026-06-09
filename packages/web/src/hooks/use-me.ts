import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface Me {
	type: string;
	is_superuser: boolean;
}

export function useMe() {
	return useQuery({
		queryKey: queryKeys.me(),
		queryFn: () => api.get<Me>('/api/me'),
	});
}
