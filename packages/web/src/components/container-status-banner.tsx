import { ContainerStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useImageBuild } from '../hooks/use-image-build';
import { useProjectMeta } from '../hooks/use-projects';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { Button } from './ui/button';
import { Progress } from './ui/progress';

const BANNER_OUTER = 'sticky top-0 z-40 bg-surface';
const BANNER_INNER = 'flex items-center gap-2 px-4 py-2 text-[13px] font-medium';

export function ContainerStatusBanner({ projectId }: { projectId: string }) {
	const project = useProjectMeta(projectId);
	const imageBuild = useImageBuild(project?.docker_base_image);
	const [isRebuilding, setIsRebuilding] = useState(false);

	const bannerRef = useCallback((node: HTMLDivElement | null) => {
		if (!node) return;
		const root = document.documentElement;
		const observer = new ResizeObserver(([entry]) => {
			root.style.setProperty('--container-banner-h', `${entry?.contentRect.height ?? 0}px`);
		});
		observer.observe(node);
		return () => {
			observer.disconnect();
			root.style.setProperty('--container-banner-h', '0px');
		};
	}, []);

	if (!project) return null;

	const status = project.container_status;

	// The shared base image is (re)building. Surface the rebuilding status with a
	// determinate progress bar. Shown whenever a build is in flight unless the
	// operator deliberately stopped the container — a "rebuilding" container can
	// still read a stale `running`/`creating` status, and the build gates every
	// container that needs the fresh image.
	const rebuilding = !!imageBuild?.building && status !== ContainerStatus.Stopped;
	if (rebuilding && imageBuild) {
		return (
			<div ref={bannerRef} className={BANNER_OUTER}>
				<Link
					to="/projects/$projectId/container"
					params={{ projectId }}
					data-testid="container-status-banner-building"
					aria-label={`Rebuilding ${project.name}'s base image. View container logs`}
					className="flex flex-col gap-1 px-4 py-2 bg-info/10 text-info transition-colors hover:bg-info/20"
				>
					<div className="flex items-center gap-2 text-[13px] font-medium">
						<Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
						<span data-testid="container-status-banner-message" className="min-w-0 truncate">
							Rebuilding {project.name}'s base image…
						</span>
						<span className="ml-auto shrink-0 tabular-nums">{imageBuild.percent}%</span>
					</div>
					<Progress value={imageBuild.percent} label="Base image build progress" />
				</Link>
			</div>
		);
	}

	// Provisioning / shutting down: a transient state that resolves on its own.
	// Show a loading banner that links to the container page for live logs.
	const provisioning = status === ContainerStatus.Creating || status === ContainerStatus.Stopping;
	if (provisioning) {
		const message =
			status === ContainerStatus.Stopping
				? `Stopping ${project.name}'s container…`
				: `Provisioning ${project.name}'s container…`;
		return (
			<div ref={bannerRef} className={BANNER_OUTER}>
				<Link
					to="/projects/$projectId/container"
					params={{ projectId }}
					data-testid="container-status-banner-provisioning"
					aria-label={`${message} View container logs`}
					className={`${BANNER_INNER} bg-info/10 text-info transition-colors hover:bg-info/20`}
				>
					<Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
					<span data-testid="container-status-banner-message" className="min-w-0 truncate">
						{message}
					</span>
					<span className="ml-auto shrink-0 hidden sm:inline opacity-80">View logs</span>
				</Link>
			</div>
		);
	}

	const unhealthy = status === ContainerStatus.Stopped || status === ContainerStatus.Error;
	if (!unhealthy) return null;

	const hasError = status === ContainerStatus.Error;
	const message = `${project.name} container is not running`;

	const rebuild = async () => {
		if (isRebuilding) return;
		setIsRebuilding(true);
		try {
			await api.post(`/api/projects/${projectId}/container/rebuild`, {});
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
		} finally {
			setIsRebuilding(false);
		}
	};

	const tone = hasError ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning';

	return (
		<div ref={bannerRef} className={BANNER_OUTER}>
			<div data-testid="container-status-banner" className={`${BANNER_INNER} ${tone}`}>
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
					aria-label="Restart failed container"
				>
					{isRebuilding ? (
						<Loader2 className="w-3 h-3 animate-spin" />
					) : (
						<RefreshCw className="w-3 h-3" />
					)}
					<span>Restart</span>
				</Button>
			</div>
		</div>
	);
}
