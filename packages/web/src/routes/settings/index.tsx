import { createFileRoute } from '@tanstack/react-router';
import { DatabaseSection } from '../../components/database-section';
import { InstanceSettingsSection } from '../../components/instance-settings-section';
import { VersionDisplay } from '../../components/version-display';

/** The default Settings page (visiting /settings with no subpage) — general instance settings. */
function GeneralSettingsPage() {
	return (
		<div className="max-w-[900px]">
			<InstanceSettingsSection />
			<DatabaseSection />
			<VersionDisplay />
		</div>
	);
}

export const Route = createFileRoute('/settings/')({
	component: GeneralSettingsPage,
});
