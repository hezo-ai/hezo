import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/teams/$teamId/')({
	component: () => {
		const { teamId } = Route.useParams();
		return <Navigate to="/teams/$teamId/tasks" params={{ teamId }} />;
	},
});
