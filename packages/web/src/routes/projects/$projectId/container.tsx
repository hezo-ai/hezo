import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, ExternalLink, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LogViewer, type LogViewerLine } from '../../../components/log-viewer';
import {
	ProjectDiskLimitSection,
	ProjectMemoryLimitSection,
} from '../../../components/project-container-limits';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { Progress } from '../../../components/ui/progress';
import { Tooltip } from '../../../components/ui/tooltip';
import {
	useRebuildContainer,
	useStartContainer,
	useStopContainer,
} from '../../../hooks/use-container';
import { useContainerLogs } from '../../../hooks/use-container-logs';
import { useImageBuild } from '../../../hooks/use-image-build';
import { useProject } from '../../../hooks/use-projects';
import { useI18n } from '../../../lib/i18n';

function ContainerPage() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const { data: project } = useProject(projectId);
	const startContainer = useStartContainer(projectId);
	const stopContainer = useStopContainer(projectId);
	const rebuildContainer = useRebuildContainer(projectId);
	const [stopOpen, setStopOpen] = useState(false);
	const [rebuildOpen, setRebuildOpen] = useState(false);

	const status = project?.container_status;
	const isRunning = status === 'running';
	const isCreating = status === 'creating';
	const isStopping = status === 'stopping';
	const isError = status === 'error';
	const hasContainer = !!project?.container_id;
	const isActive = isRunning || isCreating || isStopping;

	// The base image is shared and its build is the long pole of provisioning.
	// Surface it as a first-class phase that overrides the (possibly stale)
	// container_status — a container can read "running" while the shared image
	// rebuilds for a fresh provision.
	const imageBuild = useImageBuild(project?.docker_base_image);
	const isBuilding = imageBuild?.building ?? false;

	// While the image builds, always tail the provision stream (which carries the
	// `docker build` trace) regardless of the possibly-stale container_status.
	const logPhase =
		isBuilding || isCreating ? 'creating' : isRunning ? 'running' : isError ? 'error' : null;
	const { lines: liveLogs } = useContainerLogs(project?.id ?? '', project?.id ? logPhase : null);

	// Accumulate the build's step lines as a fallback log, so progress is visible
	// in the log panel even when this project's own provision stream isn't the one
	// driving the (shared, deduplicated) build.
	const [buildLogLines, setBuildLogLines] = useState<LogViewerLine[]>([]);
	const lastBuildStepRef = useRef<string | null>(null);
	useEffect(() => {
		if (!imageBuild?.building) {
			lastBuildStepRef.current = null;
			setBuildLogLines([]);
			return;
		}
		const stepPrefix =
			imageBuild.step !== null && imageBuild.totalSteps !== null
				? `Step ${imageBuild.step}/${imageBuild.totalSteps} `
				: '';
		const detail = `${stepPrefix}${imageBuild.label ?? ''}`.trim();
		const key = `${imageBuild.step}/${imageBuild.totalSteps}:${imageBuild.label}`;
		if (lastBuildStepRef.current === key) return; // collapse repeats of the same step
		lastBuildStepRef.current = key;
		const text = detail || `Rebuilding base image… ${imageBuild.percent}%`;
		setBuildLogLines((prev) => [...prev, { id: prev.length, stream: 'stdout', text: `→ ${text}` }]);
	}, [imageBuild]);

	const snapshotLines = useMemo<LogViewerLine[]>(() => {
		const raw = project?.container_last_logs;
		if (!raw) return [];
		return raw.split('\n').map((text, idx) => ({ id: idx, stream: 'stdout', text }));
	}, [project?.container_last_logs]);

	const showSnapshot =
		!isRunning && !isCreating && !isBuilding && liveLogs.length === 0 && snapshotLines.length > 0;
	// Prefer the real provision/container trace; fall back to the synthesised
	// build-step log only while building and when no live lines have arrived.
	const useBuildLog = isBuilding && liveLogs.length === 0;
	const logs = showSnapshot ? snapshotLines : useBuildLog ? buildLogLines : liveLogs;

	if (!project) return null;

	const anyPending =
		startContainer.isPending || stopContainer.isPending || rebuildContainer.isPending;

	return (
		<div className="flex flex-col gap-5">
			{/* Containers run on demand: agent runs and chats start this container
			    automatically, and it stops again after the global idle timeout
			    (Settings → Containers). The controls below are manual overrides. */}
			<p className="text-[13px] text-text-2 max-w-[680px]">
				This container starts automatically whenever an agent run or the assistant needs it, and
				stops after sitting idle (configurable in Settings → Concurrency). Starting or stopping it
				here is a manual override.
			</p>

			{/* Controls */}
			<div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface px-4 py-3 sm:flex-row sm:items-center">
				<div className="flex items-center gap-3">
					{isBuilding ? (
						<Badge color="info" testId="container-status-badge-building">
							Rebuilding{imageBuild ? ` ${imageBuild.percent}%` : ''}
						</Badge>
					) : (
						<ContainerStatusBadge status={project.container_status} />
					)}
					{project.container_id && (
						<span className="font-mono text-xs text-text-2">
							{project.container_id.slice(0, 12)}
						</span>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2 sm:ml-auto">
					<Tooltip content="Start container">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => startContainer.mutate()}
							disabled={anyPending || isActive || !hasContainer}
						>
							{startContainer.isPending ? (
								<Loader2 className="w-3 h-3 animate-spin" />
							) : (
								<Play className="w-3 h-3" />
							)}
							Start
						</Button>
					</Tooltip>
					<Tooltip content="Stop container">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setStopOpen(true)}
							disabled={anyPending || isStopping || (!isRunning && !isCreating)}
						>
							{stopContainer.isPending || isStopping ? (
								<Loader2 className="w-3 h-3 animate-spin" />
							) : (
								<Square className="w-3 h-3" />
							)}
							Stop
						</Button>
					</Tooltip>
					<Tooltip content="Restart container">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setRebuildOpen(true)}
							disabled={anyPending || isCreating || isStopping}
						>
							{rebuildContainer.isPending ? (
								<Loader2 className="w-3 h-3 animate-spin" />
							) : (
								<RefreshCw className="w-3 h-3" />
							)}
							Restart
						</Button>
					</Tooltip>
				</div>
			</div>

			{/* Error banner */}
			{isError && project.container_error && (
				<div className="flex gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm">
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
					<div className="flex flex-col gap-1">
						<span className="font-medium text-danger">Container error</span>
						<span className="whitespace-pre-wrap font-mono text-xs text-danger">
							{project.container_error}
						</span>
					</div>
				</div>
			)}

			{/* Committed work that reached no remote - the container is pinned, but
			    the work exists in exactly one place until a later run pushes it. */}
			{project.has_stranded_commits && (
				<div
					data-testid="stranded-commits-warning"
					className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
				>
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
					<div className="flex flex-col gap-1">
						<span className="font-medium">{t('container.strandedCommits.title')}</span>
						<span className="text-xs text-text-2">{t('container.strandedCommits.body')}</span>
					</div>
				</div>
			)}

			{/* Base-image build progress */}
			{isBuilding && imageBuild && (
				<div
					data-testid="image-build-progress"
					className="flex flex-col gap-2 rounded-lg border border-info/30 bg-info/10 px-4 py-3"
				>
					<div className="flex items-center gap-2 text-sm">
						<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-info" />
						<span className="font-medium">Rebuilding base image</span>
						<span className="truncate font-mono text-xs text-text-2">
							{project.docker_base_image}
						</span>
						<span className="ml-auto shrink-0 text-xs tabular-nums text-text-2">
							{imageBuild.percent}%
						</span>
					</div>
					<Progress value={imageBuild.percent} label="Base image build progress" />
					{(imageBuild.step !== null || imageBuild.label) && (
						<p className="truncate font-mono text-[11px] text-text-3">
							{imageBuild.step !== null && imageBuild.totalSteps !== null
								? `Step ${imageBuild.step}/${imageBuild.totalSteps}`
								: ''}
							{imageBuild.label ? ` ${imageBuild.label}` : ''}
						</p>
					)}
					<p className="text-xs text-text-2">
						This image is shared across projects and only rebuilds when its definition changes. The
						container starts automatically once the build completes.
					</p>
				</div>
			)}

			{/* Info */}
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
				<div>
					<span className="text-text-2">Image</span>
					<p className="font-mono text-xs mt-0.5">{project.docker_base_image ?? 'none'}</p>
				</div>
				{project.dev_ports?.length > 0 && (
					<div>
						<span className="text-text-2">Dev Ports</span>
						<div className="flex gap-2 flex-wrap mt-0.5">
							{project.dev_ports.map((p) => (
								<a
									key={p.host}
									href={`http://localhost:${p.host}`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 font-mono text-xs hover:text-text-1"
								>
									<ExternalLink className="w-3 h-3" />
									{p.container}→{p.host}
								</a>
							))}
						</div>
					</div>
				)}
			</div>

			<ConfirmDialog
				open={stopOpen}
				onOpenChange={setStopOpen}
				title="Stop this container?"
				description="Running agent tasks will be cancelled."
				confirmLabel="Stop"
				variant="danger"
				loading={stopContainer.isPending}
				onConfirm={async () => {
					await stopContainer.mutateAsync();
				}}
			/>

			<ConfirmDialog
				open={rebuildOpen}
				onOpenChange={setRebuildOpen}
				title="Restart container?"
				description="All unpushed work will be lost and running agent tasks will be cancelled."
				confirmLabel="Restart"
				variant="danger"
				loading={rebuildContainer.isPending}
				onConfirm={async () => {
					await rebuildContainer.mutateAsync();
				}}
			/>

			<LogViewer
				lines={logs}
				liveLabel={
					showSnapshot ? (
						<Badge color="neutral">Last known logs</Badge>
					) : isRunning || isCreating ? (
						<Badge color="success">Live</Badge>
					) : null
				}
				emptyState={
					isBuilding ? (
						<span className="inline-flex items-center gap-2">
							<Loader2 className="w-3 h-3 animate-spin" />
							Rebuilding base image…
						</span>
					) : isCreating ? (
						<span className="inline-flex items-center gap-2">
							<Loader2 className="w-3 h-3 animate-spin" />
							Provisioning container…
						</span>
					) : isStopping ? (
						<span className="inline-flex items-center gap-2">
							<Loader2 className="w-3 h-3 animate-spin" />
							Stopping container…
						</span>
					) : isRunning ? (
						<span className="inline-flex items-center gap-2">
							<Loader2 className="w-3 h-3 animate-spin" />
							Waiting for container output…
						</span>
					) : hasContainer ? (
						'Container is not running and no logs were captured.'
					) : (
						'No container provisioned.'
					)
				}
			/>

			<ProjectMemoryLimitSection projectId={projectId} />
			<ProjectDiskLimitSection projectId={projectId} />
		</div>
	);
}

function ContainerStatusBadge({ status }: { status: string | null }) {
	// `null` (never provisioned) and `stopped` are both the normal resting
	// state: the container starts on demand when a run or chat needs it.
	if (!status) return <Badge color="neutral">Starts on demand</Badge>;
	const config: Record<string, { color: string; label: string }> = {
		creating: { color: 'warning', label: 'Provisioning' },
		running: { color: 'success', label: 'Running' },
		stopping: { color: 'warning', label: 'Stopping' },
		stopped: { color: 'neutral', label: 'Stopped (starts on demand)' },
		error: { color: 'danger', label: 'Error' },
	};
	const { color, label } = config[status] ?? { color: 'neutral', label: status };
	return <Badge color={color as 'neutral'}>{label}</Badge>;
}

export const Route = createFileRoute('/projects/$projectId/container')({
	component: ContainerPage,
});
