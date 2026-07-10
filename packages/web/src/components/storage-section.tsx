import { useMe } from '../hooks/use-me';
import { AssetStorageSection } from './asset-storage-section';
import { DatabaseSection } from './database-section';

/**
 * Storage section on General settings (rendered just before the Version
 * section). Superuser-only, matching the underlying endpoints' gates. Combines
 * the database and asset-storage cards into a single split view — stacked on
 * mobile, side-by-side from `sm` up.
 */
export function StorageSection() {
	const { data: me } = useMe();
	if (me?.is_superuser !== true) return null;

	return (
		<section className="mt-8" data-testid="settings-storage">
			<div className="mb-4">
				<h2 className="text-base font-medium">Storage</h2>
				<p className="text-[13px] text-text-2 mt-1">
					Where this instance stores its data and uploaded files.
				</p>
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<DatabaseSection />
				<AssetStorageSection />
			</div>
		</section>
	);
}
