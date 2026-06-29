import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SettingsSidebar } from '../../components/settings-sidebar';
import { InfoTooltip } from '../../components/ui/info-tooltip';

/**
 * Shared chrome for every Settings page: the title and the navigation sidebar
 * (a persistent rail on desktop, a collapsed top-pinned menu on mobile). Each
 * subpage renders only its own content into the <Outlet/>.
 */
function SettingsLayout() {
	return (
		<div className="max-w-[1080px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<div className="flex items-center gap-1.5 mb-5">
				<h1 className="text-[22px] font-medium">Settings</h1>
				<InfoTooltip
					label="About settings"
					content="AI providers, plus instance-wide resources shared across teams (admin only)."
					data-testid="settings-info"
				/>
			</div>
			<div className="flex flex-col gap-2 md:grid md:grid-cols-[180px_1fr] md:gap-6 md:items-start">
				<SettingsSidebar />
				<div className="min-w-0">
					<Outlet />
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/settings')({
	component: SettingsLayout,
});
