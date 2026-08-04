import { isProvisioningPlaceholder } from '@hezo/shared';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Box, Loader2 } from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { type Column, DataTable } from '../../../components/ui/data-table';
import { EmptyState } from '../../../components/ui/empty-state';
import { Progress } from '../../../components/ui/progress';
import { RelativeTime } from '../../../components/ui/relative-time';
import { type ContainerSummary, useContainers } from '../../../hooks/use-containers';
import { useAnyImageBuild } from '../../../hooks/use-image-build';
import {
	CONTAINER_STATE_LABEL,
	CONTAINER_STATE_TONE,
	formatGib,
} from '../../../lib/container-display';
import { useI18n } from '../../../lib/i18n';

/**
 * A base image being rebuilt, shown above the list.
 *
 * It belongs here rather than on a project page: base images are shared, and one
 * building holds up *every* container that needs the fresh image - so the page
 * that answers "why is nothing starting" is the instance-wide one. It used to
 * live in the per-project banner, which announced a global event once per
 * project and could not be reached at all from the page an operator was on.
 */
function BaseImageBuild() {
	const { t } = useI18n();
	const build = useAnyImageBuild();
	if (!build) return null;

	return (
		<div
			data-testid="image-build-progress"
			className="mb-4 flex flex-col gap-2 rounded-lg border border-info/30 bg-info/10 px-4 py-3"
		>
			<div className="flex items-center gap-2 text-sm">
				<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-info" />
				<span className="font-medium">{t('containers.imageBuild.title')}</span>
				<span className="truncate font-mono text-xs text-text-2">{build.image}</span>
				<span className="ml-auto shrink-0 text-xs tabular-nums text-text-2">{build.percent}%</span>
			</div>
			<Progress value={build.percent} label={t('containers.imageBuild.title')} />
			{(build.step !== null || build.label) && (
				<p className="truncate font-mono text-[11px] text-text-3">
					{build.step !== null && build.totalSteps !== null
						? t('containers.imageBuild.step', { step: build.step, total: build.totalSteps })
						: ''}
					{build.label ? ` ${build.label}` : ''}
				</p>
			)}
		</div>
	);
}

/**
 * Every container the instance is running, across every project.
 *
 * The list exists because a project stopped having "a" container: it holds as
 * many as it has concurrent runs, so a per-project page could only ever describe
 * one of them, and could not say which. The question is instance-wide, so the
 * answer is too.
 */
function ContainersList() {
	const { t } = useI18n();
	const navigate = useNavigate();
	const { data: containers, isLoading } = useContainers();

	const columns: Column<ContainerSummary>[] = [
		{
			key: 'project',
			header: t('containers.column.project'),
			render: (row) => (
				<div className="flex items-center gap-2 min-w-0">
					<span className="truncate">{row.project_name}</span>
					{row.reserved_for_chat && (
						<Badge color="info" testId={`container-chat-${row.container_id}`}>
							{t('containers.badge.assistant')}
						</Badge>
					)}
					{row.has_unpushed_commits && (
						<Badge color="warning" testId={`container-unpushed-${row.container_id}`}>
							{t('containers.badge.unpushed')}
						</Badge>
					)}
				</div>
			),
		},
		{
			key: 'state',
			header: t('containers.column.state'),
			width: '110px',
			render: (row) => (
				<Badge
					color={CONTAINER_STATE_TONE[row.state]}
					testId={`container-state-${row.container_id}`}
				>
					{t(CONTAINER_STATE_LABEL[row.state])}
				</Badge>
			),
		},
		{
			key: 'container',
			header: t('containers.column.container'),
			width: '140px',
			hideOnMobile: true,
			// A provisioning placeholder is not an engine id, so it is shown as
			// nothing rather than as a fake one.
			render: (row) => (
				<span className="font-mono text-[11px] text-text-2">
					{isProvisioningPlaceholder(row.container_id) ? '-' : row.container_id.slice(0, 12)}
				</span>
			),
		},
		{
			key: 'task',
			header: t('containers.column.task'),
			width: '120px',
			hideOnMobile: true,
			render: (row) => <span className="text-text-2">{row.last_task_identifier ?? '-'}</span>,
		},
		{
			key: 'disk',
			header: t('containers.column.disk'),
			width: '120px',
			hideOnMobile: true,
			render: (row) => (
				<span className="text-text-2">
					{formatGib(row.disk_used_bytes)} / {formatGib(row.disk_ceiling_bytes)}
				</span>
			),
		},
		{
			key: 'memory',
			header: t('containers.column.memory'),
			width: '90px',
			hideOnMobile: true,
			render: (row) => <span className="text-text-2">{row.memory_limit_gib} GB</span>,
		},
		{
			key: 'age',
			header: t('containers.column.age'),
			width: '100px',
			hideOnMobile: true,
			render: (row) => <RelativeTime iso={row.created_at} compact />,
		},
	];

	return (
		<div data-testid="containers-list">
			<BaseImageBuild />
			{!isLoading && containers?.length === 0 ? (
				<EmptyState
					icon={<Box className="size-6" />}
					title={t('containers.empty.title')}
					description={t('containers.empty.body')}
				/>
			) : (
				<DataTable
					columns={columns}
					data={containers ?? []}
					rowKey={(row) => row.container_id}
					onRowClick={(row) =>
						navigate({
							to: '/settings/containers/$containerId',
							params: { containerId: row.container_id },
						})
					}
				/>
			)}
		</div>
	);
}

export const Route = createFileRoute('/settings/containers/')({
	component: ContainersList,
});
