import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { Clock, DollarSign } from 'lucide-react';
import { Tabs } from '../../../../components/ui/tabs';
import { useI18n } from '../../../../lib/i18n';

/**
 * The project's Budget page: what the agents cost in tokens, and what the
 * containers cost in hours.
 *
 * Two different questions with two different answers, which is why they are two
 * tabs rather than one page. Spend is priced from the model catalog per token;
 * hours are metered from container uptime, and on a managed backend they are
 * billed whether an agent is mid-run, mid-build, or warm and idle between runs.
 * Each tab carries its own URL so a link to either survives a refresh.
 *
 * **HQ gets Hours and not Spend.** It runs no project team, so it has no
 * per-project spend surface - but it does hold the assistant chat's container,
 * which is metered like any other, and it is the only scope from which the
 * instance-wide allowance can be seen or set.
 */
function BudgetLayout() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const params = { projectId };
	const isHq = projectId === HQ_PROJECT_SLUG;

	return (
		<div>
			<h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-text-1">
				{t('nav.budget')}
			</h1>
			<p className="mt-1 max-w-prose text-[13px] text-text-2">
				{isHq ? t('budget.subtitle.hq') : t('budget.subtitle')}
			</p>

			<Tabs
				aria-label={t('nav.budget')}
				className="mt-5 mb-5 overflow-x-auto"
				items={[
					// HQ has no Spend tab, so its strip is one item. Rendered rather than
					// hidden: the Hours tab still needs its own selected state, and a strip
					// that vanishes on one project reads as a missing page.
					...(isHq
						? []
						: [
								{
									// Exact: Spend is the index route, so a fuzzy match would also
									// claim `/budget/hours` and light both tabs at once.
									to: '/projects/$projectId/budget/' as const,
									exact: true,
									params,
									label: t('budget.tab.spend'),
									icon: <DollarSign className="h-3.5 w-3.5" aria-hidden />,
									testId: 'budget-tab-spend',
								},
							]),
					{
						to: '/projects/$projectId/budget/hours' as const,
						params,
						label: t('budget.tab.hours'),
						icon: <Clock className="h-3.5 w-3.5" aria-hidden />,
						testId: 'budget-tab-hours',
					},
				]}
			/>

			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/budget')({
	beforeLoad: ({ params, location }) => {
		// HQ has no per-project spend, so its index redirects to the tab it does
		// have rather than 404ing or rendering an empty Spend page.
		if (params.projectId === HQ_PROJECT_SLUG && !location.pathname.endsWith('/hours')) {
			throw redirect({ to: '/projects/$projectId/budget/hours', params, replace: true });
		}
	},
	component: BudgetLayout,
});
