import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/projects/$projectId/')({
	component: () => {
		const { projectId } = Route.useParams();
		return <Navigate to="/projects/$projectId/dashboard" params={{ projectId }} />;
	},
});
