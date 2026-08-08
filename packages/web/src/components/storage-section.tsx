import { useMe } from '../hooks/use-me';
import { AssetStorageSection } from './asset-storage-section';
import { DatabaseSection } from './database-section';
import { SandboxBackendSection } from './sandbox-backend-section';

/**
 * Storage section, rendered on the dedicated Storage settings subpage.
 * Superuser-only, matching the underlying endpoints' gates. Combines the
 * database, asset-storage and sandbox-backend cards into a single split view —
 * stacked on mobile, side-by-side from `sm` up. The database card is much
 * taller (it carries the compaction control), so the two short cards share its
 * column rather than each claiming a row of their own.
 */
export function StorageSection() {
	const { data: me } = useMe();
	if (me?.is_superuser !== true) return null;

	return (
		<section data-testid="settings-storage">
			<div className="mb-4">
				<h2 className="text-base font-medium">Storage</h2>
				<p className="text-[13px] text-text-2 mt-1">
					Where this instance stores its data and uploaded files, and where agent containers run.
				</p>
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<DatabaseSection />
				<div className="grid grid-cols-1 gap-3">
					<AssetStorageSection />
					<SandboxBackendSection />
				</div>
			</div>
		</section>
	);
}
