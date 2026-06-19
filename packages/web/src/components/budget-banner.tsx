import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useBudgetStatus } from '../hooks/use-costs';

const BANNER_OUTER = 'sticky top-0 z-30 bg-surface';
const BANNER_INNER = 'flex items-center gap-2 px-4 py-2 text-[13px] font-medium';

/**
 * Warns at the top of a project when the project or one or more of its agents has
 * exceeded a budget window. Links to the Budgets page. Paused agents resume only
 * once spend falls back under the limit (the next window) or limits are raised.
 */
export function BudgetBanner({ projectId }: { projectId: string }) {
	const { data: status } = useBudgetStatus(projectId);
	if (!status) return null;

	const projectOver = status.project.overBudget;
	const overAgents = status.agents.filter((a) => a.agent_over_budget);
	if (!projectOver && overAgents.length === 0) return null;

	const message = projectOver
		? 'Project is over budget — agent runs are paused'
		: `${overAgents.length} agent${overAgents.length === 1 ? '' : 's'} over budget — run${
				overAgents.length === 1 ? '' : 's'
			} paused`;

	return (
		<div className={BANNER_OUTER}>
			<Link
				to="/projects/$projectId/budget"
				params={{ projectId }}
				data-testid="budget-banner"
				aria-label={`${message}. View budgets`}
				className={`${BANNER_INNER} bg-danger/10 text-danger transition-colors hover:bg-danger/20`}
			>
				<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
				<span data-testid="budget-banner-message" className="min-w-0 truncate">
					{message}
				</span>
				<span className="ml-auto hidden shrink-0 opacity-80 sm:inline">View budgets</span>
			</Link>
		</div>
	);
}
