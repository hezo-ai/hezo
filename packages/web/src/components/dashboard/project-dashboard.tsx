import { KeyRound } from 'lucide-react';
import { useGoals } from '../../hooks/use-goals';
import { useNeedsYou } from '../../hooks/use-inbox-count';
import { useProject, useProjectMeta } from '../../hooks/use-projects';
import { useI18n } from '../../lib/i18n';
import { Card } from '../ui/card';
import { EmptyState } from '../ui/empty-state';
import { ActionItems } from './action-items';
import { ActiveAgentsStrip } from './active-agents-strip';
import { DashboardGoals } from './dashboard-goals';
import { DashboardMetrics } from './dashboard-metrics';
import { DashboardSpend } from './dashboard-spend';
import { InProgressTasks } from './in-progress-tasks';
import { ProjectProgressSummary } from './progress-summary';
import { ProgressUpdateRuns } from './progress-update-runs';

function DashboardSkeleton() {
	return (
		<div className="flex flex-col gap-5" data-testid="project-dashboard-loading">
			<div className="h-8 w-48 animate-pulse rounded bg-surface-2" />
			<div className="h-16 w-full animate-pulse rounded-lg bg-surface-2" />
			<div className="h-32 w-full animate-pulse rounded-lg bg-surface-2" />
			<div className="h-40 w-full animate-pulse rounded-lg bg-surface-2" />
		</div>
	);
}

/**
 * The project's home page, and the only place its progress is reported.
 *
 * The page reads as four bands, each answering a different question: the metric strip says what
 * state the project is in, the Captain's summary says what that state means, the two columns
 * carry the work and the readouts, and the heartbeat history at the bottom says where the summary
 * came from.
 *
 * HQ has neither goals nor a progress summary, so it renders the same page minus those bands
 * rather than a second layout.
 */
export function ProjectDashboardView({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const projectMeta = useProjectMeta(projectId);
	const { data: project, isLoading } = useProject(projectId);
	const { data: needsYou } = useNeedsYou(projectId);
	const isInternal = project?.is_internal ?? projectMeta?.is_internal ?? false;
	const { data: goals } = useGoals(projectId, { enabled: !isInternal });

	if (isLoading && !projectMeta) return <DashboardSkeleton />;

	const actionRows = needsYou?.items ?? [];

	return (
		<div className="flex flex-col gap-5" data-testid="project-dashboard">
			<header>
				<h1 className="text-xl font-semibold text-text-1">
					{project?.name ?? projectMeta?.name ?? projectId}
				</h1>
			</header>

			<DashboardMetrics
				projectId={projectId}
				goals={goals ?? []}
				actionCount={needsYou?.action_count ?? 0}
				isInternal={isInternal}
			/>

			{!isInternal && <ProjectProgressSummary projectId={projectId} />}

			<ActiveAgentsStrip projectId={projectId} />

			<div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.55fr_1fr]">
				<div className="flex min-w-0 flex-col gap-5">
					<ActionItems
						projectId={projectId}
						rows={actionRows}
						actionCount={needsYou?.action_count ?? 0}
					/>
					<InProgressTasks projectId={projectId} />
				</div>

				{!isInternal && (
					<div className="flex min-w-0 flex-col gap-5">
						<DashboardGoals projectId={projectId} goals={goals ?? []} />
						<DashboardSpend projectId={projectId} />
					</div>
				)}
			</div>

			{isInternal && actionRows.length === 0 && (
				<Card>
					<EmptyState
						icon={<KeyRound className="h-5 w-5" />}
						title={t('dashboard.hq.readyTitle')}
						description={t('dashboard.hq.readyHint')}
					/>
				</Card>
			)}

			{!isInternal && <ProgressUpdateRuns projectId={projectId} />}
		</div>
	);
}
