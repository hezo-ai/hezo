import { ContainerStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useProjectMeta } from '../hooks/use-projects';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { Button } from './ui/button';

const BANNER_BASE = 'sticky top-0 z-40 flex items-center gap-2 px-4 py-2 text-[13px] font-medium';

export function ContainerStatusBanner({ projectId }: { projectId: string }) {
	const project = useProjectMeta(projectId);
	const [isRebuilding, setIsRebuilding] = useState(false);

	if (!project) return null;

	const status = project.container_status;

	// Provisioning / shutting down: a transient state that resolves on its own.
	// Show a loading banner that links to the container page for live logs.
	const provisioning = status === ContainerStatus.Creating || status === ContainerStatus.Stopping;
	if (provisioning) {
		const message =
			status === ContainerStatus.Stopping
				? `Stopping ${project.name}'s container…`
				: `Provisioning ${project.name}'s container…`;
		return (
			<Link
				to="/projects/$projectId/container"
				params={{ projectId }}
				data-testid="container-status-banner-provisioning"
				aria-label={`${message} View container logs`}
				className={`${BANNER_BASE} bg-blue-500/10 text-blue-400 transition-colors hover:bg-blue-500/20`}
			>
				<Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
				<span data-testid="container-status-banner-message" className="min-w-0 truncate">
					{message}
				</span>
				<span className="ml-auto shrink-0 hidden sm:inline opacity-80">View logs</span>
			</Link>
		);
	}

	const unhealthy = status === ContainerStatus.Stopped || status === ContainerStatus.Error;
	if (!unhealthy) return null;

	const hasError = status === ContainerStatus.Error;
	const message = `${project.name} container failed`;

	const rebuild = async () => {
		if (isRebuilding) return;
		setIsRebuilding(true);
		try {
			await api.post(`/api/projects/${projectId}/container/rebuild`, {});
			queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
		} finally {
			setIsRebuilding(false);
		}
	};

	const tone = hasError ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400';

	return (
		<div data-testid="container-status-banner" className={`${BANNER_BASE} ${tone}`}>
			<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
			<span data-testid="container-status-banner-message" className="min-w-0 truncate">
				{message}
			</span>
			<Button
				variant="ghost"
				size="sm"
				onClick={rebuild}
				disabled={isRebuilding}
				className="ml-auto shrink-0"
				aria-label="Rebuild failed container"
			>
				{isRebuilding ? (
					<Loader2 className="w-3 h-3 animate-spin" />
				) : (
					<RefreshCw className="w-3 h-3" />
				)}
				<span className="hidden sm:inline">Rebuild</span>
				<span className="sm:hidden">Rebuild</span>
			</Button>
		</div>
	);
}
