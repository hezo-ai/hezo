import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/companies/$companyId/projects/$projectId/')({
	component: () => {
		const { companyId, projectId } = Route.useParams();
		return (
			<Navigate
				to="/companies/$companyId/projects/$projectId/issues"
				params={{ companyId, projectId }}
			/>
		);
	},
});
