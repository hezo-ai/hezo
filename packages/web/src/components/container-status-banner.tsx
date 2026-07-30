import { Link } from '@tanstack/react-router';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useContainerHealth } from '../hooks/use-container-health';
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
	const health = useContainerHealth(project);
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

	// `stopped` is the normal resting state — containers start on demand when a
	// run or chat needs them — so it gets no banner at all; only genuine errors
	// and in-flight transitions are surfaced.
	if (!project || !health || health.kind === 'healthy' || health.kind === 'stopped') return null;

	// The shared base image is (re)building. Surface the rebuilding status with a
	// determinate progress bar — the build gates every container that needs the
	// fresh image.
	if (health.kind === 'rebuilding') {
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
						<span className="ml-auto shrink-0 tabular-nums">{health.percent}%</span>
					</div>
					<Progress value={health.percent} label="Base image build progress" />
				</Link>
			</div>
		);
	}

	// Provisioning / shutting down: a transient state that resolves on its own.
	// Show a loading banner that links to the container page for live logs.
	if (health.kind === 'provisioning') {
		const message =
			health.transient === 'stopping'
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

	// Errored — the container needs attention. The banner body links to the
	// container page; the Restart button rebuilds in place without navigating.
	const message = `${project.name} container hit an error`;

	const rebuild = async (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (isRebuilding) return;
		setIsRebuilding(true);
		try {
			await api.post(`/api/projects/${projectId}/container/rebuild`, {});
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
		} finally {
			setIsRebuilding(false);
		}
	};

	const tone = 'bg-danger/10 text-danger hover:bg-danger/20';

	return (
		<div ref={bannerRef} className={BANNER_OUTER}>
			<Link
				to="/projects/$projectId/container"
				params={{ projectId }}
				data-testid="container-status-banner"
				aria-label={`${message}. View container`}
				className={`${BANNER_INNER} ${tone} transition-colors`}
			>
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
			</Link>
		</div>
	);
}
