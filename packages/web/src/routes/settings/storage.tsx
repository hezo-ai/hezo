import { createFileRoute } from '@tanstack/react-router';
import { StorageSection } from '../../components/storage-section';
import { useMe } from '../../hooks/use-me';

/**
 * Storage settings subpage: where this instance keeps its database and uploaded
 * files, plus database maintenance (run-log compaction, old-version pruning).
 * Superuser-only, matching the underlying endpoints' gates.
 */
function StorageSettingsPage() {
	const { data: me } = useMe();
	if (me && !me.is_superuser) {
		return (
			<div className="max-w-[900px]">
				<p className="text-[13px] text-text-2">
					Storage settings are managed by the Admin. You don't have access to this page.
				</p>
			</div>
		);
	}
	return (
		<div className="max-w-[900px]">
			<StorageSection />
		</div>
	);
}

export const Route = createFileRoute('/settings/storage')({
	component: StorageSettingsPage,
});
