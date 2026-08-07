import { isProvisioningPlaceholder } from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { LogViewer, type LogViewerLine } from '../../../components/log-viewer';
import { BackLink } from '../../../components/ui/back-link';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { useContainerLogs } from '../../../hooks/use-container-logs';
import { useContainer, useRemoveContainer } from '../../../hooks/use-containers';
import { toast } from '../../../hooks/use-toast';
import { containerBadge, formatGib } from '../../../lib/container-display';
import { useI18n } from '../../../lib/i18n';

/**
 * One container: what it is, what it is doing, and what it last said.
 *
 * The log is the reason this page exists. It used to live on the project's
 * container page, where it showed whichever container `projects.container_id`
 * happened to name - so an operator looking into why *this* container died was
 * reading another one's output. Here it is unambiguous, and it survives the
 * container: `last_logs` is captured on the member row before removal.
 */
function ContainerDetail() {
	const { containerId } = Route.useParams();
	const { t } = useI18n();
	const navigate = useNavigate();
	const { data: container, isLoading } = useContainer(containerId);
	const removeContainer = useRemoveContainer();
	const [confirmOpen, setConfirmOpen] = useState(false);

	// A provision that has no engine id yet: there is a row so the page an
	// operator is sent to during provisioning is not empty, but nothing exists to
	// stream from or remove.
	const provisioning = isProvisioningPlaceholder(containerId);
	// A container still coming up is the case the log matters most for: the
	// provisioning trace is written to its stream while it is in that state, and
	// the server replays what it already holds on subscribe. A stopped one has
	// nothing to stream and falls back to the snapshot captured when it stopped.
	const streaming =
		container?.state === 'creating' || container?.state === 'busy' || container?.state === 'idle';
	const { lines: liveLines } = useContainerLogs(containerId, streaming ? 'running' : null);

	const snapshot: LogViewerLine[] = (container?.last_logs ?? '')
		.split('\n')
		.filter((line) => line.length > 0)
		.map((text, id) => ({ id, stream: 'stdout' as const, text }));
	const lines = liveLines.length > 0 ? liveLines : snapshot;

	if (isLoading) return null;
	if (!container) {
		return <p className="text-[13px] text-text-2">{t('containers.detail.gone')}</p>;
	}

	async function handleRemove() {
		try {
			await removeContainer.mutateAsync(containerId);
			navigate({ to: '/settings/containers' });
		} catch (e) {
			toast.error((e as Error).message);
		}
	}

	return (
		<div data-testid="container-detail">
			<BackLink
				onClick={() => navigate({ to: '/settings/containers' })}
				label={t('containers.detail.back')}
			/>

			<div className="flex flex-wrap items-center justify-between gap-3 mt-3 mb-4">
				<div className="flex items-center gap-2 min-w-0">
					<Badge
						color={containerBadge(container.state, container.reserved_for_chat).tone}
						testId="container-detail-state"
					>
						{t(containerBadge(container.state, container.reserved_for_chat).label)}
					</Badge>
					{!provisioning && (
						<span className="font-mono text-[12px] text-text-2 truncate">
							{container.container_id}
						</span>
					)}
				</div>
				{!provisioning && (
					<Button
						variant="destructive"
						onClick={() => setConfirmOpen(true)}
						disabled={removeContainer.isPending}
						data-testid="container-remove"
					>
						<Trash2 className="size-3.5" />
						{t('containers.detail.remove')}
					</Button>
				)}
			</div>

			<dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-[13px]">
				<div>
					<dt className="text-text-3">{t('containers.column.project')}</dt>
					<dd className="mt-0.5">
						{/* The project itself, not its container settings: from here the
						    question is "whose container is this", and the answer is the
						    project you want to look at. */}
						<Link
							to="/projects/$projectId"
							params={{ projectId: container.project_slug }}
							className="text-accent hover:underline"
						>
							{container.project_name}
						</Link>
					</dd>
				</div>
				<div>
					<dt className="text-text-3">{t('containers.column.task')}</dt>
					<dd className="mt-0.5">
						{container.last_task_identifier ? (
							<Link
								to="/projects/$projectId/tasks/$taskId"
								params={{
									projectId: container.project_slug,
									// Task routes take the lowercased identifier, not the UUID.
									taskId: container.last_task_identifier.toLowerCase(),
								}}
								className="text-accent hover:underline"
								data-testid="container-detail-task"
							>
								{container.last_task_identifier}
							</Link>
						) : (
							'-'
						)}
					</dd>
				</div>
				<div>
					<dt className="text-text-3">{t('containers.column.disk')}</dt>
					<dd className="mt-0.5">
						{formatGib(container.disk_used_bytes)} / {formatGib(container.disk_ceiling_bytes)}
					</dd>
				</div>
				<div>
					<dt className="text-text-3">{t('containers.column.memory')}</dt>
					<dd className="mt-0.5">
						{container.memory_bytes === null ? '-' : formatGib(container.memory_bytes)}
					</dd>
				</div>
			</dl>

			{container.last_error && (
				<div
					className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger mb-4"
					data-testid="container-detail-error"
				>
					{container.last_error}
				</div>
			)}

			<LogViewer
				lines={lines}
				emptyState={
					// A container that is still coming up has not finished producing its
					// log, so the terminal wording reads as a container that came up
					// silently - which is the opposite of what is happening.
					<span>
						{t(
							container.state === 'creating'
								? 'containers.detail.waitingForLogs'
								: 'containers.detail.noLogs',
						)}
					</span>
				}
				testId="container-detail-logs"
			/>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				variant="danger"
				title={t('containers.detail.confirm.title')}
				description={
					// A busy container is the main reason to reach for Remove, so the
					// confirm names the run it ends rather than refusing. The run dies the
					// same way it would have if the container had crashed.
					container.run_id
						? t('containers.detail.confirm.busy')
						: t('containers.detail.confirm.body')
				}
				confirmLabel={t('containers.detail.remove')}
				loading={removeContainer.isPending}
				onConfirm={handleRemove}
			/>
		</div>
	);
}

export const Route = createFileRoute('/settings/containers/$containerId')({
	component: ContainerDetail,
});
