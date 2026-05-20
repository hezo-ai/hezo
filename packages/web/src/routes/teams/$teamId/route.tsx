import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ContainerStatusBanner } from '../../../components/container-status-banner';
import { useTeam } from '../../../hooks/use-teams';
import { useWebSocket } from '../../../hooks/use-websocket';

function TeamLayout() {
	const { teamId } = Route.useParams();
	const { data: team, error } = useTeam(teamId);
	const navigate = useNavigate();

	useEffect(() => {
		if (error && (error as { status?: number }).status === 404) {
			navigate({ to: '/home', replace: true });
		}
	}, [error, navigate]);

	useWebSocket(team?.id, teamId);

	return (
		<div className="flex flex-col">
			<ContainerStatusBanner teamId={teamId} />
			<div className="max-w-[1000px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
				<Outlet />
			</div>
		</div>
	);
}

export const Route = createFileRoute('/teams/$teamId')({
	component: TeamLayout,
});
