import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/companies/$companyId/')({
	component: () => {
		const { companyId } = Route.useParams();
		return <Navigate to="/companies/$companyId/issues" params={{ companyId }} />;
	},
});
