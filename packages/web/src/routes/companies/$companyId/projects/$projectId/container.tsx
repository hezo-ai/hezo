import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, ExternalLink, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import { useMemo } from 'react';
import { LogViewer, type LogViewerLine } from '../../../../../components/log-viewer';
import { Badge } from '../../../../../components/ui/badge';
import { Button } from '../../../../../components/ui/button';
import {
	useRebuildContainer,
	useStartContainer,
	useStopContainer,
} from '../../../../../hooks/use-container';
import { useContainerLogs } from '../../../../../hooks/use-container-logs';
import { useProject } from '../../../../../hooks/use-projects';

function ContainerPage() {
	const { companyId, projectId } = Route.useParams();
	const { data: project } = useProject(companyId, projectId);
	const startContainer = useStartContainer(companyId, projectId);
	const stopContainer = useStopContainer(companyId, projectId);
	const rebuildContainer = useRebuildContainer(companyId, projectId);

	const status = project?.container_status;
	const isRunning = status === 'running';
	const isCreating = status === 'creating';
	const isStopping = status === 'stopping';
	const isError = status === 'error';
	const hasContainer = !!project?.container_id;
	const isActive = isRunning || isCreating || isStopping;

	const logPhase = isCreating ? 'creating' : isRunning ? 'running' : isError ? 'error' : null;
	const { lines: liveLogs, clear } = useContainerLogs(
		project?.id ?? '',
		project?.id ? logPhase : null,
	);

	const snapshotLines = useMemo<LogViewerLine[]>(() => {
		const raw = project?.container_last_logs;
		if (!raw) return [];
		return raw.split('\n').map((text, idx) => ({ id: idx, stream: 'stdout', text }));
	}, [project?.container_last_logs]);

	const showSnapshot =
		!isRunning && !isCreating && liveLogs.length === 0 && snapshotLines.length > 0;
	const logs = showSnapshot ? snapshotLines : liveLogs;

	if (!project) return null;

	const anyPending =
		startContainer.isPending || stopContainer.isPending || rebuildContainer.isPending;

	return (
		<div className="flex flex-col gap-5">
			{/* Controls */}
			<div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg px-4 py-3">
				<ContainerStatusBadge status={project.container_status} />
				{project.container_id && (
					<span className="font-mono text-xs text-text-muted">
						{project.container_id.slice(0, 12)}
					</span>
				)}
				<div className="ml-auto flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => startContainer.mutate()}
						disabled={anyPending || isActive || !hasContainer}
						title="Start container"
					>
						{startContainer.isPending ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<Play className="w-3 h-3" />
						)}
						Start
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							if (confirm('Stop this container? Running agent tasks will be cancelled.')) {
								stopContainer.mutate();
							}
						}}
						disabled={anyPending || isStopping || (!isRunning && !isCreating)}
						title="Stop container"
					>
						{stopContainer.isPending || isStopping ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<Square className="w-3 h-3" />
						)}
						Stop
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							if (
								confirm(
									'Rebuild container from scratch? All unpushed work will be lost and running agent tasks will be cancelled.',
								)
							) {
								rebuildContainer.mutate();
							}
						}}
						disabled={anyPending || isCreating || isStopping}
						title="Rebuild container from scratch"
					>
						{rebuildContainer.isPending ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<RefreshCw className="w-3 h-3" />
						)}
						Rebuild
					</Button>
				</div>
			</div>

			{/* Error banner */}
			{isError && project.container_error && (
				<div className="flex gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
					<div className="flex flex-col gap-1">
						<span className="font-medium text-red-400">Container error</span>
						<span className="whitespace-pre-wrap font-mono text-xs text-red-200/90">
							{project.container_error}
						</span>
					</div>
				</div>
			)}

			{/* Info */}
			<div className="grid grid-cols-2 gap-4 text-sm">
				<div>
					<span className="text-text-muted">Image</span>
					<p className="font-mono text-xs mt-0.5">{project.docker_base_image ?? 'none'}</p>
				</div>
				{project.dev_ports?.length > 0 && (
					<div>
						<span className="text-text-muted">Dev Ports</span>
						<div className="flex gap-2 flex-wrap mt-0.5">
							{project.dev_ports.map((p) => (
								<a
									key={p.host}
									href={`http://localhost:${p.host}`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 font-mono text-xs hover:text-primary"
								>
									<ExternalLink className="w-3 h-3" />
									{p.container}→{p.host}
								</a>
							))}
						</div>
					</div>
				)}
			</div>

			<LogViewer
				lines={logs}
				onClear={showSnapshot ? undefined : clear}
				liveLabel={
					showSnapshot ? (
						<Badge color="neutral">Last known logs</Badge>
					) : isRunning || isCreating ? (
						<Badge color="success">Live</Badge>
					) : null
				}
				emptyState={
					isCreating ? (
						<span className="inline-flex items-center gap-2">
							<Loader2 className="w-3 h-3 animate-spin" />
							Provisioning container…
						</span>
					) : isStopping ? (
						<span className="inline-flex items-center gap-2">
							<Loader2 className="w-3 h-3 animate-spin" />
							Stopping container…
						</span>
					) : hasContainer ? (
						'Container is not running and no logs were captured.'
					) : (
						'No container provisioned.'
					)
				}
			/>
		</div>
	);
}

function ContainerStatusBadge({ status }: { status: string | null }) {
	if (!status) return <Badge color="gray">No container</Badge>;
	const config: Record<string, { color: string; label: string }> = {
		creating: { color: 'warning', label: 'Provisioning' },
		running: { color: 'success', label: 'Running' },
		stopping: { color: 'warning', label: 'Stopping' },
		stopped: { color: 'neutral', label: 'Stopped' },
		error: { color: 'danger', label: 'Error' },
	};
	const { color, label } = config[status] ?? { color: 'neutral', label: status };
	return <Badge color={color as 'neutral'}>{label}</Badge>;
}

export const Route = createFileRoute('/companies/$companyId/projects/$projectId/container')({
	component: ContainerPage,
});
