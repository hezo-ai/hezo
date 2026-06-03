import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Me {
	type: string;
	is_superuser: boolean;
}

export function useMe() {
	return useQuery({
		queryKey: ['me'],
		queryFn: () => api.get<Me>('/api/me'),
	});
}
