import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface Me {
	type: string;
	is_superuser: boolean;
}

/**
 * The authenticated caller's identity. Also serves as the session probe for the
 * top-level gate: a 401 means "unlocked but no valid session → show login". The
 * gate passes `retry: false` so that 401 surfaces immediately (a missing/expired
 * token won't fix itself), and `enabled: false` to hold the probe until unlock.
 * Both default to the plain useQuery behavior so existing callers are unchanged.
 */
export function useMe(options?: { enabled?: boolean; retry?: boolean }) {
	return useQuery({
		queryKey: queryKeys.me(),
		queryFn: () => api.get<Me>('/api/me'),
		enabled: options?.enabled ?? true,
		...(options?.retry !== undefined ? { retry: options.retry } : {}),
	});
}
