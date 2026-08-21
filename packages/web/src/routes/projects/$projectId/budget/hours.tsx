import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import {
	InstanceContainerHoursPanel,
	ProjectContainerHoursPanel,
} from '../../../../components/budget/container-hours-panel';

/**
 * The Hours tab: how long containers were up.
 *
 * HQ gets the instance-wide view, which is where the allowance lives - it is set
 * once and gates every project's container starts, so showing it per project
 * would imply a per-project figure that does not exist.
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
