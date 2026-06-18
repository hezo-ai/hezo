import { AlertTriangle, ChevronRight, Loader2, RotateCw } from 'lucide-react';
import { useRetryFailedRun } from '../../hooks/use-retry-failed-run';
import type { Task } from '../../hooks/use-tasks';
import { jumpToComment } from './comments-section';

interface Props {
	task: Task;
	/** Route-param slug — required to wire the Retry action. */
	projectId?: string;
	/** Route-param slug — required to wire the Retry action. */
	taskId?: string;
}

export function LastRunFailedBanner({ task, projectId, taskId }: Props) {
	const failed = task.last_run_status === 'failed' || task.last_run_status === 'timed_out';
	if (task.has_active_run || !failed || !task.last_run_comment_public_id) return null;

	const commentId = task.last_run_comment_public_id;
	return (
		<div className="mb-4 flex items-stretch gap-2">
			<a
				href={`#comment-${commentId}`}
				onClick={jumpToComment(commentId)}
				data-testid="last-run-failed-banner"
				className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-accent-red/10 px-4 py-2 text-[13px] font-medium text-red-400 hover:bg-accent-red/15 transition-colors"
			>
				<AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">
					{task.last_run_status === 'timed_out' ? 'Last run timed out' : 'Last run failed'} — view
					it
				</span>
				<span className="ml-auto flex items-center gap-1 shrink-0">
					<span className="hidden sm:inline">Jump to run</span>
					<ChevronRight className="w-3.5 h-3.5" />
				</span>
			</a>
			{/*
			 * The durable manual-retry path: the inline button on the `run_failed`
			 * comment disappears once that ping is suppressed (3+ consecutive
			 * failures), but this banner stays as long as the last run failed and
			 * nothing is running — so retry must remain reachable here.
			 */}
			{projectId && taskId && task.last_run_id ? (
				<RetryButton projectId={projectId} taskId={taskId} runId={task.last_run_id} />
			) : null}
		</div>
	);
}

function RetryButton({
	projectId,
	taskId,
	runId,
}: {
	projectId: string;
	taskId: string;
	runId: string;
}) {
	const retry = useRetryFailedRun({ projectId, taskId });
	return (
		<button
			type="button"
			onClick={() => retry.mutate(runId)}
			disabled={retry.isPending}
			aria-label="Retry failed run"
			data-testid="retry-failed-run-banner"
			className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent-red/10 px-3 text-[13px] font-medium text-red-400 hover:bg-accent-red/15 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
		>
			{retry.isPending ? (
				<Loader2 className="w-3.5 h-3.5 animate-spin" />
			) : (
				<RotateCw className="w-3.5 h-3.5" />
			)}
			Retry
		</button>
	);
}
