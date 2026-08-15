import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Clock, List } from 'lucide-react';
import { Tabs } from '../../../../components/ui/tabs';
import { useI18n } from '../../../../lib/i18n';

/**
 * The project's Activity page: what happened, and how long it took.
 *
 * A top-level project page rather than a Settings sub-item - it is a working
 * surface the team reads, not configuration set once, and nested under Settings
 * it was invisible from every other page. Each tab carries its own URL so a link
 * to either survives a refresh.
 */
function ActivityLayout() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const params = { projectId };

	return (
		<div>
			<h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-text-1">
				{t('nav.activity')}
			</h1>
			<p className="mt-1 max-w-prose text-[13px] text-text-2">{t('activity.subtitle')}</p>

			<Tabs
				aria-label={t('nav.activity')}
				className="mt-5 mb-5 overflow-x-auto"
				items={[
					{
						// Exact: the log is the index route, so a fuzzy match would also
						// claim `/activity/hours` and light both tabs at once.
						to: '/projects/$projectId/activity/',
						exact: true,
						params,
						label: t('activity.tab.log'),
						icon: <List className="h-3.5 w-3.5" aria-hidden />,
						testId: 'activity-tab-log',
					},
					{
						to: '/projects/$projectId/activity/hours',
						params,
						label: t('activity.tab.hours'),
						icon: <Clock className="h-3.5 w-3.5" aria-hidden />,
						testId: 'activity-tab-hours',
					},
				]}
			/>

			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/activity')({
	component: ActivityLayout,
});
