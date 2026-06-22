import { AlertTriangle, ChevronRight } from 'lucide-react';
import type { Task } from '../../hooks/use-tasks';
import { jumpToComment } from '../comment-renderers';

interface Props {
	task: Task;
}

export function LastRunFailedBanner({ task }: Props) {
	const failed = task.last_run_status === 'failed' || task.last_run_status === 'timed_out';
	if (task.has_active_run || !failed || !task.last_run_comment_public_id) return null;

	const commentId = task.last_run_comment_public_id;
	return (
		<a
			href={`#comment-${commentId}`}
			onClick={jumpToComment(commentId)}
			data-testid="last-run-failed-banner"
			className="mb-4 flex items-center gap-2 rounded-md bg-danger/10 px-4 py-2 text-[13px] font-medium text-danger hover:bg-danger/15 transition-colors"
		>
			<AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate">
				{task.last_run_status === 'timed_out' ? 'Last run timed out' : 'Last run failed'} — view it
			</span>
			<span className="ml-auto flex items-center gap-1 shrink-0">
				<span className="hidden sm:inline">Jump to run</span>
				<ChevronRight className="w-3.5 h-3.5" />
			</span>
		</a>
	);
}
