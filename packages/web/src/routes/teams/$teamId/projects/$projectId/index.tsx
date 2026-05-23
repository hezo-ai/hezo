import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/teams/$teamId/projects/$projectId/')({
	component: () => {
		const { teamId, projectId } = Route.useParams();
		return (
			<Navigate to="/teams/$teamId/projects/$projectId/tasks" params={{ teamId, projectId }} />
		);
	},
});
