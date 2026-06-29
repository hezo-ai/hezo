import { createFileRoute } from '@tanstack/react-router';
import { InstanceSettingsSection } from '../../components/instance-settings-section';

/** The default Settings page (visiting /settings with no subpage) — general instance settings. */
function GeneralSettingsPage() {
	return (
		<div className="max-w-[900px]">
			<InstanceSettingsSection />
		</div>
	);
}

export const Route = createFileRoute('/settings/')({
	component: GeneralSettingsPage,
});
