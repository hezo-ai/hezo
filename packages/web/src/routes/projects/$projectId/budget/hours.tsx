import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import {
	InstanceContainerHoursPanel,
	ProjectContainerHoursPanel,
} from '../../../../components/budget/container-hours-panel';

/**
 * The Hours tab: how long containers were up, and against what.
 *
 * HQ gets the instance-wide view, which is where the allowance lives - it is set
 * once and gates every project's container starts. Every other project gets its
 * own uptime and its own hours budget, which the instance owner sets beneath
 * that allowance.
 */
function BudgetHoursPage() {
	const { projectId } = Route.useParams();
	return projectId === HQ_PROJECT_SLUG ? (
		<InstanceContainerHoursPanel />
	) : (
		<ProjectContainerHoursPanel projectId={projectId} />
	);
}

export const Route = createFileRoute('/projects/$projectId/budget/hours')({
	component: BudgetHoursPage,
});
