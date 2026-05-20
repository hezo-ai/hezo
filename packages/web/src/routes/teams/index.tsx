import { createFileRoute, Navigate } from '@tanstack/react-router';

/** Legacy path — team list lives at /home. */
export const Route = createFileRoute('/teams/')({
	component: () => <Navigate to="/home" replace />,
});
