import { createFileRoute } from '@tanstack/react-router';
import { AgentHoursPanel } from '../../../../components/activity/agent-hours-panel';

/** The Hours tab: how long each agent spent working in this project. */
function ProjectActivityHoursPage() {
	const { projectId } = Route.useParams();
	return <AgentHoursPanel projectId={projectId} />;
}

export const Route = createFileRoute('/projects/$projectId/activity/hours')({
	component: ProjectActivityHoursPage,
});
