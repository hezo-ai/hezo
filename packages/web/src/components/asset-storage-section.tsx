import { Cloud, HardDrive } from 'lucide-react';
import { type AssetStorageInfo, useAssetStorageInfo } from '../hooks/use-asset-storage-info';
import { useMe } from '../hooks/use-me';

/**
 * Asset-storage card, rendered side-by-side with the database card inside
 * {@link StorageSection}. Superuser-only, matching the endpoint's gate. The
 * storage URL arrives pre-redacted from the server — this component never sees,
 * stores, or reveals the raw URL.
 */
export function AssetStorageSection() {
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const { data: info } = useAssetStorageInfo(isSuperuser);

	if (!isSuperuser) return null;

	return (
		<div
			className="border border-border rounded-md p-3 bg-surface"
			data-testid="settings-asset-storage"
		>
			{info === undefined ? null : <AssetStorageDetails info={info} />}
		</div>
	);
}

function AssetStorageDetails({ info }: { info: AssetStorageInfo }) {
	const isS3 = info.backend === 's3';
	// Icon stands in for the storage type — an object-storage bucket vs. the
	// local disk.
	const Icon = isS3 ? Cloud : HardDrive;
	return (
		<div className="flex items-start gap-3">
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-2">
				<Icon className="h-4 w-4" />
			</div>
			<div className="min-w-0">
				<div className="flex items-baseline gap-1.5 flex-wrap">
					<h3 className="text-[13px] font-medium">Asset storage</h3>
					<span className="text-[10px] text-text-3" aria-hidden="true">
						&bull;
					</span>
					<span className="text-[13px] text-text-2" data-testid="settings-asset-storage-backend">
						{isS3 ? 'S3-compatible object storage' : 'Local filesystem'}
					</span>
				</div>
				<p
					className="text-[12px] text-text-2 mt-1 font-mono break-all"
					data-testid="settings-asset-storage-display"
				>
					{info.display}
				</p>
			</div>
		</div>
	);
}
