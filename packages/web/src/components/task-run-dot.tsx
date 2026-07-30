import type { QueuedWakeup } from '../hooks/use-tasks';
import { Tooltip } from './ui/tooltip';

interface TaskRunDotProps {
	/** True when an agent run is currently queued or executing for the task. */
	hasActiveRun: boolean;
	/** The task's parked wakeup, if a run is waiting rather than in flight. */
	queuedWakeup: Pick<QueuedWakeup, 'reason'> | null;
}

/**
 * Run-state dot shown beside a task reference: an amber pulsing dot while an
 * agent run is in flight, a blue dot when a run is queued and waiting, and
 * nothing when the task is idle. Shared by the task list, the sub-tasks list,
 * and the "Blocked By" dependency list so the indicator stays identical
 * everywhere a task is referenced.
 */
export function TaskRunDot({ hasActiveRun, queuedWakeup }: TaskRunDotProps) {
	if (hasActiveRun) {
		return (
			<Tooltip content="Agent run in progress">
				<span
					role="img"
					aria-label="Agent run in progress"
					data-testid="task-running-dot"
					className="inline-block w-2 h-2 rounded-full bg-warning animate-pulse shrink-0"
				/>
			</Tooltip>
		);
	}
	if (queuedWakeup) {
		const label =
			queuedWakeup.reason === 'instance_at_capacity' ||
			queuedWakeup.reason === 'project_at_capacity'
				? 'Run queued — at the container limit'
				: 'Run queued — waiting';
		return (
			<Tooltip content={label}>
				<span
					role="img"
					aria-label={label}
					data-testid="task-queued-dot"
					className="inline-block w-2 h-2 rounded-full bg-info shrink-0"
				/>
			</Tooltip>
		);
	}
	return null;
}
