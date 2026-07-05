import { type AssetStorageInfo, useAssetStorageInfo } from '../hooks/use-asset-storage-info';
import { useMe } from '../hooks/use-me';

/**
 * Asset-storage card on General settings (rendered right after the Database
 * section). Superuser-only, matching the endpoint's gate. The storage URL
 * arrives pre-redacted from the server — this component never sees, stores,
 * or reveals the raw URL.
 */
export function AssetStorageSection() {
	const { data: me } = useMe();
	const isSuperuser = me?.is_superuser === true;
	const { data: info } = useAssetStorageInfo(isSuperuser);

	if (!isSuperuser) return null;

	return (
		<section className="mt-8" data-testid="settings-asset-storage">
			<div className="mb-4">
				<h2 className="text-base font-medium">Asset storage</h2>
				<p className="text-[13px] text-text-2 mt-1">
					Where this instance stores uploaded asset files.
				</p>
			</div>
			<div className="border border-border rounded-md p-3 bg-surface">
				{info === undefined ? null : <AssetStorageDetails info={info} />}
			</div>
		</section>
	);
}

function AssetStorageDetails({ info }: { info: AssetStorageInfo }) {
	return (
		<dl className="flex flex-col gap-3">
			<div>
				<dt className="text-[13px] font-medium">Storage</dt>
				<dd className="text-[13px] text-text-2 mt-0.5" data-testid="settings-asset-storage-backend">
					{info.backend === 's3' ? 'S3-compatible object storage' : 'Local filesystem'}
				</dd>
			</div>
			<div>
				<dt className="text-[13px] font-medium">{info.backend === 's3' ? 'Bucket' : 'Location'}</dt>
				<dd
					className="text-[13px] text-text-2 mt-0.5 font-mono break-all"
					data-testid="settings-asset-storage-display"
				>
					{info.display}
				</dd>
			</div>
		</dl>
	);
}
