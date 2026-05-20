import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/teams/$teamId/')({
	component: () => {
		const { teamId } = Route.useParams();
		return <Navigate to="/teams/$teamId/issues" params={{ teamId }} />;
	},
});
