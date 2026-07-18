import { useMutation, useQuery } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface AdminUser {
	id: string;
	display_name: string;
	is_superuser: boolean;
	/** Optional custom avatar (signed URL); null when unset (falls back to initials). */
	icon_url: string | null;
	icon_updated_at: string | null;
}

export interface UserIconResponse {
	icon_url: string | null;
	icon_updated_at: string | null;
}

/** Human users (today just the admin). Superuser-only on the server. */
export function useUsers() {
	return useQuery({
		queryKey: queryKeys.users(),
		queryFn: () => api.get<AdminUser[]>('/api/users'),
	});
}

/**
 * Seed a user's icon fields into the users cache from a server response, then
 * invalidate to reconcile. Response-driven (the server returns the signed
 * `icon_url`), not optimistic.
 */
function applyUserIconToCache(userId: string, icon: UserIconResponse) {
	queryClient.setQueryData<AdminUser[]>(queryKeys.users(), (old) =>
		old?.map((u) =>
			u.id === userId
				? { ...u, icon_url: icon.icon_url, icon_updated_at: icon.icon_updated_at }
				: u,
		),
	);
	queryClient.invalidateQueries({ queryKey: queryKeys.users() });
}

/** Upload (or replace) a user's avatar. `blob` is the normalized square PNG. */
export function useUploadUserIcon(userId: string) {
	return useMutation<UserIconResponse, ApiError, Blob>({
		mutationFn: (blob) => {
			const fd = new FormData();
			fd.set('file', blob, 'icon.png');
			return api.putForm<UserIconResponse>(`/api/users/${userId}/icon`, fd);
		},
		onSuccess: (data) => applyUserIconToCache(userId, data),
	});
}

export function useRemoveUserIcon(userId: string) {
	return useMutation<UserIconResponse, ApiError, void>({
		mutationFn: () => api.delete<UserIconResponse>(`/api/users/${userId}/icon`),
		onSuccess: () => applyUserIconToCache(userId, { icon_url: null, icon_updated_at: null }),
	});
}
