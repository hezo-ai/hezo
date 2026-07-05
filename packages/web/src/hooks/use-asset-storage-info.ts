import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface AssetStorageInfo {
	backend: 'local' | 's3';
	/**
	 * Server-side redacted display string — the local assets dir (local) or the
	 * occluded storage URL (s3). The raw URL never reaches the client.
	 */
	display: string;
}

/** Superuser-only endpoint — pass `enabled: false` for other users to avoid a 403 fetch. */
export function useAssetStorageInfo(enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.assetStorageInfo(),
		queryFn: () => api.get<AssetStorageInfo>('/api/asset-storage-info'),
		enabled,
	});
}
