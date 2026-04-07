import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink, Loader2, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
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
	const hasContainer = !!project?.container_id;
	const isActive = isRunning || isCreating || isStopping;

	const { logs, clear } = useContainerLogs(project?.id ?? '', isRunning && hasContainer && !!project?.id);

	const [autoScroll, setAutoScroll] = useState(true);
	const logEndRef = useRef<HTMLDivElement>(null);
	const prevLogCount = useRef(0);

	if (autoScroll && logs.length !== prevLogCount.current) {
		prevLogCount.current = logs.length;
		queueMicrotask(() => logEndRef.current?.scrollIntoView({ behavior: 'smooth' }));
	}

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
						onClick={() => stopContainer.mutate()}
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
						onClick={() => rebuildContainer.mutate()}
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

			{/* Log Viewer */}
			<div className="flex flex-col rounded-lg border border-border-subtle overflow-hidden">
				<div className="flex items-center justify-between bg-bg-subtle px-3 py-1.5 border-b border-border-subtle">
					<span className="text-xs text-text-muted font-medium">Logs</span>
					<div className="flex items-center gap-2">
						<label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
							<input
								type="checkbox"
								checked={autoScroll}
								onChange={(e) => setAutoScroll(e.target.checked)}
								className="rounded"
							/>
							Auto-scroll
						</label>
						<Button variant="ghost" size="sm" onClick={clear} className="text-xs h-6 px-2">
							<Trash2 className="w-3 h-3" /> Clear
						</Button>
					</div>
				</div>
				<div className="bg-[#0d1117] h-[400px] overflow-y-auto p-3 font-mono text-xs leading-relaxed">
					{!isRunning && logs.length === 0 && (
						<span className="text-text-subtle">
							{isCreating ? (
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
								'Container is not running.'
							) : (
								'No container provisioned.'
							)}
						</span>
					)}
					{logs.map((line) => (
						<div
							key={line.id}
							className={line.stream === 'stderr' ? 'text-red-400' : 'text-gray-300'}
						>
							{line.text}
						</div>
					))}
					<div ref={logEndRef} />
				</div>
			</div>
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
