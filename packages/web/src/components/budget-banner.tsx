import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useProjectMenuCollapsed } from '../hooks/use-project-menu-collapsed';
import { useBudgetStatus } from '../hooks/use-usage';
import { bannerInnerClass } from '../lib/banner-classes';
import { useI18n } from '../lib/i18n';

const BANNER_OUTER = 'sticky top-0 z-30 bg-surface';

/**
 * Warns at the top of a project when the project or one or more of its agents has
 * exceeded a budget window, and links to the tab where that budget lives: the
 * Tokens tab for a token budget, the Hours tab for the project's hours. Paused
 * agents resume only once usage falls back under the limit (the next window) or
 * limits are raised.
 */
export function BudgetBanner({ projectId }: { projectId: string }) {
	const { t, plural } = useI18n();
	const { data: status } = useBudgetStatus(projectId);
	const [menuCollapsed] = useProjectMenuCollapsed();
	if (!status) return null;

	const projectOver = status.project.overBudget;
	const hoursOver = status.project_hours_over_budget === true;
	const overAgents = status.agents.filter((a) => a.agent_over_budget);
	if (!projectOver && !hoursOver && overAgents.length === 0) return null;

	const message = projectOver
		? t('budget.banner.projectTokens')
		: hoursOver
			? t('budget.banner.projectHours')
			: plural('budget.banner.agents', overAgents.length, { count: overAgents.length });
	const linkLabel = t('budget.banner.view');
	const to =
		!projectOver && hoursOver ? '/projects/$projectId/budget/hours' : '/projects/$projectId/budget';

	return (
		<div className={BANNER_OUTER}>
			<Link
				to={to}
				params={{ projectId }}
				data-testid="budget-banner"
				aria-label={`${message}. ${linkLabel}`}
				className={`${bannerInnerClass(menuCollapsed)} bg-danger/10 text-danger transition-colors hover:bg-danger/20`}
			>
				<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
				<span data-testid="budget-banner-message" className="min-w-0 truncate">
					{message}
				</span>
				<span className="ml-auto hidden shrink-0 opacity-80 sm:inline">{linkLabel}</span>
			</Link>
		</div>
	);
}
