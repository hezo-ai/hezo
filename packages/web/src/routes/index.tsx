import { DEFAULT_TEAM_SLUG } from '@hezo/shared';
import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
	component: () => <Navigate to="/teams/$teamId" params={{ teamId: DEFAULT_TEAM_SLUG }} replace />,
});
