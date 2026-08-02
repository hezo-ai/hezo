import { emptyProgressActivity } from '@hezo/shared';
import { useGoals } from '../../hooks/use-goals';
import { useProjectProgress } from '../../hooks/use-projects';
import { useI18n } from '../../lib/i18n';
import { ProjectProgressSummary } from '../project-progress-summary';
import { GoalProgressIndicator } from './goal-progress-indicator';
import { ProgressUpdateRuns } from './progress-update-runs';
import { RecentTaskColumns } from './recent-task-columns';

/**
 * The project's Progress page: the Captain's high-level summary with the goal indicator beside
 * it, the three recent-activity columns, then the progress-update run history.
 *
 * Summary and columns come from one request — they are one artifact written by one run — so this
 * reads `useProjectProgress` once and hands the pieces down.
 */
export function ProgressPage({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const { data: progress } = useProjectProgress(projectId);
	const { data: goals } = useGoals(projectId);

	return (
		<div>
			<h1 className="mb-4 text-lg font-semibold text-text-1">{t('nav.progress')}</h1>
			<ProjectProgressSummary
				projectId={projectId}
				indicator={<GoalProgressIndicator projectId={projectId} goals={goals ?? []} />}
			/>
			<RecentTaskColumns
				projectId={projectId}
				activity={progress?.activity ?? emptyProgressActivity()}
			/>
			<ProgressUpdateRuns projectId={projectId} />
		</div>
	);
}
