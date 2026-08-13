import { createFileRoute } from '@tanstack/react-router';
import { AppearanceSection } from '../../components/appearance-section';

/**
 * Settings -> Appearance. Home for the two display settings that are not about
 * language: the per-browser theme, and the instance-wide default task view.
 * Readable by anyone; the task view is writable only by a superuser, which the
 * section handles per block.
 */
function AppearanceSettingsPage() {
	return <AppearanceSection />;
}

export const Route = createFileRoute('/settings/appearance')({
	component: AppearanceSettingsPage,
});
