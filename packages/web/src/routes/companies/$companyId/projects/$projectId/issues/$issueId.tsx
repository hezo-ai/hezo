import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/companies/$companyId/projects/$projectId/issues/$issueId')({
	component: () => {
		const { companyId, issueId } = Route.useParams();
		return <Navigate to="/companies/$companyId/issues/$issueId" params={{ companyId, issueId }} />;
	},
});
