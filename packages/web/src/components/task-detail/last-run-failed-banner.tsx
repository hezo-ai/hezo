import { HeartbeatRunStatus } from '@hezo/shared';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import type { Task } from '../../hooks/use-tasks';
import { useI18n } from '../../lib/i18n';
import { jumpToComment } from '../comment-renderers';
import { runErrorSummary } from '../comment-renderers/helpers';

interface Props {
	task: Task;
}

export function LastRunFailedBanner({ task }: Props) {
	const { t } = useI18n();
	const timedOut = task.last_run_status === HeartbeatRunStatus.TimedOut;
	const failed = timedOut || task.last_run_status === HeartbeatRunStatus.Failed;
	if (task.has_active_run || !failed || !task.last_run_comment_public_id) return null;

	const commentId = task.last_run_comment_public_id;
	const reason = runErrorSummary(task.last_run_error);
	// Four keys rather than two plus a {status} variable: the status word inflects
	// with the sentence in several of these languages.
	const label = reason
		? t(timedOut ? 'tasks.lastRun.timedOutReason' : 'tasks.lastRun.failedReason', { reason })
		: t(timedOut ? 'tasks.lastRun.timedOut' : 'tasks.lastRun.failed');
	return (
		<a
			href={`#comment-${commentId}`}
			onClick={jumpToComment(commentId)}
			data-testid="last-run-failed-banner"
			className="mb-4 flex items-center gap-2 rounded-md bg-danger/10 px-4 py-2 text-[13px] font-medium text-danger hover:bg-danger/15 transition-colors"
		>
			<AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate">{label}</span>
			<span className="ml-auto flex items-center gap-1 shrink-0">
				<span className="hidden sm:inline">{t('tasks.lastRun.jump')}</span>
				<ChevronRight className="w-3.5 h-3.5" />
			</span>
		</a>
	);
}
